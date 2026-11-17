// SPDX-License-Identifier: LGPL-3.0-only

//! Staging of ciphertexts for rounds whose inputs are accepted on a remote chain.
//!
//! The remote contract verifies the ballot proof, so there is no L1 job to run: the server checks
//! that the bytes are the ciphertext the voter committed to, keeps them, and attests that it holds
//! them. The remote contract then accepts the input only with that attestation. The ingest task
//! pairs each accepted input with its staged bytes (`remote_input::ingest_round`).

use super::*;
use crate::server::repo::CRISP_KEY_PREFIX;
use crisp_aztec_ingest::{AztecInputSource, AztecNode};
use crisp_remote_input::{Attestation, AvailabilityAttester, InputStatement, RemoteInputSource};

/// The part of a remote program's configuration that staging needs.
#[derive(Clone)]
pub(super) struct RemoteInputs {
    attester: AvailabilityAttester,
    source: Arc<dyn RemoteInputSource>,
    ttl_seconds: u64,
}

impl RemoteInputs {
    /// `None` for an instance that serves the L1 program.
    pub(super) fn from_config(config: &Config) -> anyhow::Result<Option<Self>> {
        if !config.is_aztec() {
            return Ok(None);
        }
        let node = AztecNode::new(required(
            config.aztec_node_url.as_deref(),
            "AZTEC_NODE_URL",
        )?)
        .map_err(from_eyre)?;
        let source = AztecInputSource::new(
            node,
            config.aztec_contract().map_err(anyhow::Error::from)?,
            config
                .interfold_address
                .parse()
                .map_err(|error| anyhow::anyhow!("the Interfold address is invalid: {error}"))?,
            config.aztec_start_block,
        );
        let signer = config
            .private_key
            .parse()
            .map_err(|error| anyhow::anyhow!("invalid signer key: {error}"))?;
        let program = config
            .e3_program_address
            .parse()
            .map_err(|error| anyhow::anyhow!("the E3 program address is invalid: {error}"))?;
        Ok(Some(Self {
            attester: AvailabilityAttester::new(signer, config.chain_id, program),
            source: Arc::new(source),
            ttl_seconds: config.aztec_attestation_ttl_seconds,
        }))
    }
}

/// One ciphertext a voter asks the server to attest.
pub struct RemoteInputRequest {
    pub e3_id: String,
    pub slot: Address,
    pub ciphertext: Vec<u8>,
    pub commitment: B256,
    pub parent_index_plus_one: u64,
}

/// Why a round does not accept a staged input, judged from the chain facts of its L1 request.
fn check_round_accepts(
    round_program: Address,
    configured_program: Address,
    input_end: u64,
    now: u64,
) -> Result<(), InputRejected> {
    if round_program != configured_program {
        return Err(InputRejected("The round belongs to another program"));
    }
    if now >= input_end {
        return Err(InputRejected("The input window has closed"));
    }
    Ok(())
}

/// The staging key: the bytes of one round, so a round's objects go together.
fn staging_key(e3_id: U256, content_hash: B256) -> [u8; 64] {
    let mut key = [0u8; 64];
    key[..32].copy_from_slice(&e3_id.to_be_bytes::<32>());
    key[32..].copy_from_slice(content_hash.as_slice());
    key
}

impl AvailabilityService {
    /// The source of the remote inputs, when this instance serves a remote program.
    pub fn remote_source(&self) -> Option<Arc<dyn RemoteInputSource>> {
        self.remote
            .as_ref()
            .map(|remote| Arc::clone(&remote.source))
    }

    /// The signer of the attestations: its address, and the public key (`x || y`) that the remote
    /// contract stores to verify them.
    pub fn remote_signer(&self) -> Option<(Address, [u8; 64])> {
        self.remote.as_ref().map(|remote| {
            (
                remote.attester.signer_address(),
                remote.attester.signer_public_key(),
            )
        })
    }

    /// Stage one ciphertext of a round and attest that this service holds it.
    ///
    /// The ballot proof is not checked here: the remote contract verifies it before it accepts the
    /// input. What the attestation promises is availability, so the bytes are checked against the
    /// commitment the voter proves, and stored before the signature leaves the service.
    pub async fn stage_remote_input(
        &self,
        request: RemoteInputRequest,
    ) -> anyhow::Result<Attestation> {
        let remote = self
            .remote
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("this instance does not serve a remote program"))?;
        let e3_id = canonical_e3_id(&request.e3_id)
            .map_err(|_| reject_input("The E3 identifier is invalid"))?;
        let e3_id_value =
            e3_id_to_u256(&e3_id).map_err(|_| reject_input("The E3 identifier is invalid"))?;
        e3_data_availability::validate_object_bytes(&request.ciphertext)
            .map_err(|_| reject_input("The encrypted vote is empty or too large"))?;
        let content_hash = keccak256(&request.ciphertext);
        let statement = InputStatement::new(
            e3_id_value,
            content_hash,
            request.commitment,
            request.slot,
            request.parent_index_plus_one,
        )
        .map_err(|_| reject_input("The parent index is invalid"))?;

        if self
            .round_records
            .get(format!("{CRISP_KEY_PREFIX}{e3_id}"))?
            .is_none()
        {
            return Err(reject_input("The round is not known to this server"));
        }
        let e3 = self
            .interfold_read()
            .await?
            .get_e3(e3_id_value)
            .await
            .map_err(from_eyre)?;
        check_round_accepts(
            e3.e3Program,
            self.e3_program_address,
            duration_u64(e3.inputWindow[1], "input deadline")?,
            self.chain_timestamp().await?,
        )?;

        // The proof binds the commitment, not the bytes: check the bytes against it before this
        // service attests to them.
        self.validate_input_ciphertext(
            e3_id_value,
            Bytes::from(request.ciphertext.clone()),
            request.commitment,
        )
        .await?;

        // The attestation outlives this request, so the bytes are durable before it is signed.
        self.admit_remote_object(e3_id_value, content_hash, &request.ciphertext)?;

        // The remote chain compares `expiresAt` with its own clock. A chain that has produced no
        // block for a while lags the wall clock, and the next block takes the later time.
        let remote_now = remote.source.latest_timestamp().await.map_err(from_eyre)?;
        let expires_at = remote_now
            .max(wall_clock_seconds())
            .checked_add(remote.ttl_seconds)
            .ok_or_else(|| anyhow::anyhow!("attestation expiry overflows u64"))?;
        remote
            .attester
            .attest(&statement, expires_at)
            .map_err(from_eyre)
    }

    /// Keep the bytes of a staged input until its round is over.
    ///
    /// The staged bytes are bounded like the pending objects of the L1 path. Unlike that path they
    /// are not backed by a verified proof, so the bound and the caller limits of the route are all
    /// that stop unproved bytes from filling the allowance until their round ends.
    fn admit_remote_object(
        &self,
        e3_id: U256,
        content_hash: B256,
        ciphertext: &[u8],
    ) -> anyhow::Result<()> {
        let _storage = lock(&self.storage);
        let key = staging_key(e3_id, content_hash);
        if self.remote_objects.get(key)?.is_none() {
            let mut required = ciphertext.len() as u64;
            for entry in self.remote_objects.iter() {
                required = required.saturating_add(entry?.1.len() as u64);
            }
            anyhow::ensure!(
                required <= self.max_pending_bytes,
                "staged input storage is full; configured limit is {} bytes",
                self.max_pending_bytes
            );
            self.remote_objects.insert(key, ciphertext)?;
            self.remote_objects.flush()?;
        }
        Ok(())
    }

    /// The bytes staged for `content_hash` in round `e3_id`.
    pub fn remote_object(
        &self,
        e3_id: U256,
        content_hash: B256,
    ) -> anyhow::Result<Option<Vec<u8>>> {
        Ok(self
            .remote_objects
            .get(staging_key(e3_id, content_hash))?
            .map(|bytes| bytes.to_vec()))
    }

    /// Drop everything staged for a round whose inputs are no longer needed.
    pub fn release_remote_objects(&self, e3_id: U256) -> anyhow::Result<usize> {
        let _storage = lock(&self.storage);
        let mut released = 0;
        for entry in self.remote_objects.scan_prefix(e3_id.to_be_bytes::<32>()) {
            let (key, _) = entry?;
            self.remote_objects.remove(key)?;
            released += 1;
        }
        if released > 0 {
            self.remote_objects.flush()?;
        }
        Ok(released)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::data_availability::tests::test_service;
    use alloy::primitives::address;

    const PROGRAM: Address = address!("0x00000000000000000000000000000000000000a1");
    const OTHER: Address = address!("0x00000000000000000000000000000000000000b2");

    #[test]
    fn a_round_accepts_inputs_of_its_program_until_its_window_closes() {
        assert!(check_round_accepts(PROGRAM, PROGRAM, 100, 99).is_ok());
        assert_eq!(
            check_round_accepts(PROGRAM, PROGRAM, 100, 100)
                .unwrap_err()
                .0,
            "The input window has closed"
        );
        assert_eq!(
            check_round_accepts(OTHER, PROGRAM, 100, 1).unwrap_err().0,
            "The round belongs to another program"
        );
    }

    #[test]
    fn staged_bytes_are_found_by_round_and_hash_and_released_with_their_round() {
        let service = test_service(1024);
        let (one, two) = (U256::from(1), U256::from(2));
        let (bytes, other) = (b"ciphertext".as_slice(), b"another".as_slice());
        let hash = keccak256(bytes);

        service.admit_remote_object(one, hash, bytes).unwrap();
        service
            .admit_remote_object(two, keccak256(other), other)
            .unwrap();

        assert_eq!(
            service.remote_object(one, hash).unwrap().as_deref(),
            Some(bytes)
        );
        // The same hash in another round is not staged.
        assert_eq!(service.remote_object(two, hash).unwrap(), None);

        assert_eq!(service.release_remote_objects(one).unwrap(), 1);
        assert_eq!(service.remote_object(one, hash).unwrap(), None);
        assert_eq!(
            service
                .remote_object(two, keccak256(other))
                .unwrap()
                .as_deref(),
            Some(other)
        );
    }

    #[test]
    fn staged_bytes_are_bounded_and_a_repeat_costs_nothing() {
        let service = test_service(10);
        let round = U256::from(1);
        let bytes = b"12345678";
        let hash = keccak256(bytes);

        service.admit_remote_object(round, hash, bytes).unwrap();
        // The same statement again fits although the store is nearly full.
        service.admit_remote_object(round, hash, bytes).unwrap();
        // Other bytes do not.
        let other = b"abcdefgh";
        assert!(service
            .admit_remote_object(round, keccak256(other), other)
            .is_err());
        assert_eq!(
            service.remote_object(round, keccak256(other)).unwrap(),
            None
        );
    }
}
