// SPDX-License-Identifier: LGPL-3.0-only

//! Ballots of rounds whose inputs the voting contract on the Gnosis chain accepts.
//!
//! The contract verifies the ballot proof itself, and a ballot is accepted only with this
//! service's attestation that it holds the ciphertext. There is no L1 job to run and no
//! publication to wait for: the voter posts the ballot, this service checks it with an `eth_call`
//! of `validateInputProof`, keeps the ciphertext, signs, and either sends `publishInput` from the
//! relay key or hands the signed payload back for the voter's wallet to send.

use super::*;
use crate::server::repo::CRISP_KEY_PREFIX;
use crisp_gnosis_ingest::GnosisInputSource;
use crisp_remote_input::{AvailabilityAttester, InputStatement, RemoteInputSource};

/// The widest `eth_getLogs` range when `INDEX_CHUNK_SIZE` is not set.
const DEFAULT_LOG_CHUNK_SIZE: u64 = 10_000;

alloy::sol! {
    #[sol(rpc)]
    interface IGnosisRelay {
        function publishInput(uint256 e3Id, bytes data) external;
    }
}

/// What this service needs of the voting chain.
#[derive(Clone)]
pub(super) struct GnosisInputs {
    pub(super) attester: AvailabilityAttester,
    pub(super) source: Arc<GnosisInputSource>,
    ttl_seconds: u64,
    voting: Address,
    rpc_url: String,
}

impl GnosisInputs {
    /// `None` for an instance that does not serve the Gnosis program.
    pub(super) fn from_config(config: &Config) -> anyhow::Result<Option<Self>> {
        if !config.is_gnosis() {
            return Ok(None);
        }
        let voting = config.gnosis_voting().map_err(anyhow::Error::from)?;
        let signer = config
            .private_key
            .parse()
            .map_err(|error| anyhow::anyhow!("invalid signer key: {error}"))?;
        let provider = rpc::http_provider(&config.gnosis_rpc_url).map_err(from_eyre)?;
        Ok(Some(Self {
            attester: AvailabilityAttester::new(signer, config.gnosis_chain_id, voting),
            source: Arc::new(GnosisInputSource::new(
                provider,
                voting,
                config.gnosis_start_block.unwrap_or_default(),
                config.index_chunk_size.unwrap_or(DEFAULT_LOG_CHUNK_SIZE),
            )),
            ttl_seconds: config.gnosis_attestation_ttl_seconds,
            voting,
            rpc_url: config.gnosis_rpc_url.clone(),
        }))
    }
}

/// How an accepted ballot reaches the voting contract.
#[derive(Debug, PartialEq, Eq)]
pub enum GnosisBroadcast {
    /// The relay key sent `publishInput`, and the transaction is mined.
    Relayed { tx_hash: String },
    /// The voter's wallet sends `publishInput(e3Id, payload)`: the relay is off, past a limit, or
    /// out of funds, or the voter asked to send it.
    Wallet { payload: Vec<u8> },
}

impl AvailabilityService {
    fn gnosis_inputs(&self) -> anyhow::Result<&GnosisInputs> {
        self.gnosis
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("this instance does not serve the Gnosis program"))
    }

    /// The voting contract, writable with the relay key.
    async fn voting_contract(&self, gnosis: &GnosisInputs) -> anyhow::Result<CRISPContract> {
        CRISPContract::new(&gnosis.rpc_url, &self.private_key, &gnosis.voting.to_string())
            .await
            .map_err(from_eyre)
    }

    /// Send `publishInput` from the relay key, at the voting chain's fees
    /// (`rpc::gnosis_wallet_provider`).
    async fn relay_publish_input(
        &self,
        gnosis: &GnosisInputs,
        e3_id: U256,
        data: Bytes,
    ) -> eyre::Result<TransactionReceipt> {
        let signer: alloy::signers::local::PrivateKeySigner = self
            .private_key
            .parse()
            .map_err(|error| eyre::eyre!("invalid relay key: {error}"))?;
        let from = signer.address();
        let provider = rpc::gnosis_wallet_provider(&gnosis.rpc_url, signer)?;
        let voting = IGnosisRelay::new(gnosis.voting, &provider);
        let receipt =
            e3_sdk::evm::nonce::send_with_next_nonce(voting.publishInput(e3_id, data), from)
                .await?
                .get_receipt()
                .await?;
        eyre::ensure!(receipt.status(), "publishInput transaction reverted");
        Ok(receipt)
    }

    /// The voting chain reader, when this instance serves the Gnosis program.
    pub fn gnosis_source(&self) -> Option<Arc<GnosisInputSource>> {
        self.gnosis.as_ref().map(|gnosis| Arc::clone(&gnosis.source))
    }

    /// Accept one ballot of a Gnosis round: check it, keep its ciphertext, attest to it, and send
    /// it or hand the payload back.
    ///
    /// The checks that need no chain come first. Then the ciphertext is checked against the
    /// commitment the proof binds (the proof binds the commitment, not the bytes), and the voting
    /// contract dry-runs the ballot: the round, its window and limit, the slot's weight, the
    /// parent, and the proof. A revert is the caller's ballot and is refused; an unreadable chain
    /// is the service's failure. The ciphertext is durable before the signature leaves.
    ///
    /// The limits never refuse a ballot: past them, the answer is the payload for the voter's
    /// wallet. `reservation` is the caller's slot of the global relay window, `None` when the window
    /// is full; it is kept only when a relay transaction is sent.
    ///
    /// A ballot already accepted reverts in the dry run (`InputAlreadyCommitted`), so a retry of a
    /// ballot that was sent is refused instead of sent again.
    pub async fn broadcast_gnosis(
        &self,
        e3_id: &str,
        encoded_envelope: &[u8],
        send_from_wallet: bool,
        reservation: Option<GlobalReservation<'_>>,
    ) -> anyhow::Result<GnosisBroadcast> {
        let gnosis = self.gnosis_inputs()?;
        let (e3_id, envelope, content_hash, id) = self.input_identity(e3_id, encoded_envelope)?;
        let e3_id_value =
            e3_id_to_u256(&e3_id).map_err(|_| reject_input("The E3 identifier is invalid"))?;
        if self
            .round_records
            .get(format!("{CRISP_KEY_PREFIX}{e3_id}"))?
            .is_none()
        {
            return Err(reject_input("The round is not known to this server"));
        }
        self.ensure_remote_capacity(
            e3_id_value,
            content_hash,
            envelope.availabilityProof.len(),
        )?;
        self.validate_input_ciphertext(
            e3_id_value,
            envelope.availabilityProof.clone(),
            envelope.encryptedVoteCommitment,
        )
        .await?;

        let parent_index = envelope.parent_index();
        let contract = self.voting_contract(gnosis).await?;
        contract
            .validate_input_proof(
                e3_id_value,
                envelope.noirProof.clone(),
                envelope.slotAddress,
                envelope.encryptedVoteCommitment,
                envelope.encryptedVoteHash,
                parent_index,
            )
            .await?;

        self.admit_remote_object(e3_id_value, content_hash, &envelope.availabilityProof)?;
        let statement = InputStatement::new(
            e3_id_value,
            content_hash,
            envelope.encryptedVoteCommitment,
            envelope.slotAddress,
            parent_index,
        )
        .map_err(|_| reject_input("The parent index is invalid"))?;
        // The contract compares `expiresAt` with its own clock. A chain that has produced no block
        // for a while lags the wall clock, and the next block takes the later time.
        let expires_at = gnosis
            .source
            .latest_timestamp()
            .await
            .map_err(from_eyre)?
            .max(wall_clock_seconds())
            .checked_add(gnosis.ttl_seconds)
            .ok_or_else(|| anyhow::anyhow!("attestation expiry overflows u64"))?;
        let attestation = gnosis
            .attester
            .attest(&statement, expires_at)
            .map_err(from_eyre)?;
        let mut signature = Vec::with_capacity(65);
        signature.extend_from_slice(&attestation.signature);
        signature.push(attestation.v);
        let payload = InputCommitmentEnvelope {
            noirProof: envelope.noirProof,
            slotAddress: envelope.slotAddress,
            encryptedVoteCommitment: envelope.encryptedVoteCommitment,
            encryptedVoteHash: envelope.encryptedVoteHash,
            parentIndexPlusOne: envelope.parentIndexPlusOne,
            availabilityAttestationExpiresAt: expires_at,
            availabilityAttestation: Bytes::from(signature),
        }
        .abi_encode_params();

        let Some(reservation) = reservation.filter(|_| !send_from_wallet) else {
            return Ok(GnosisBroadcast::Wallet { payload });
        };
        if !self.relay_may_send_on(&gnosis.rpc_url).await
            || !self.reserve_gnosis_relay(&e3_id, envelope.slotAddress, &id)?
        {
            return Ok(GnosisBroadcast::Wallet { payload });
        }
        // The relay slot is spent from here: the send below can still cost gas.
        reservation.commit();

        let data = Bytes::from(payload.clone());
        contract
            .simulate_publish_input(e3_id_value, data.clone())
            .await?;
        match self.relay_publish_input(gnosis, e3_id_value, data).await {
            Ok(receipt) => Ok(GnosisBroadcast::Relayed {
                tx_hash: receipt.transaction_hash.to_string(),
            }),
            // A retry with the same key would fail until the window closes and lose the ballot.
            Err(error) if is_insufficient_funds(&error) => {
                warn!(%error, "The relay key cannot pay; the voter's wallet sends the ballot");
                Ok(GnosisBroadcast::Wallet { payload })
            }
            Err(error) => Err(from_eyre(error)),
        }
    }

    /// Whether the relay limits allow one more relayed ballot of `slot` in round `e3_id`, and the
    /// record of it. A round without an indexed input window is not relayed: the commitment cutoff
    /// of its records is not known.
    fn reserve_gnosis_relay(
        &self,
        e3_id: &str,
        slot: Address,
        id: &str,
    ) -> anyhow::Result<bool> {
        let Some([_, input_end]) = self.input_window(e3_id)? else {
            return Ok(false);
        };
        self.reserve_relay_slot(e3_id, slot, id, input_end)
    }
}
