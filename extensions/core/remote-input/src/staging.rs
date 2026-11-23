// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

//! The statement of a staging pass (`extensions/core/circuits/staging_pass`) as the server reads it.
//!
//! A pass is a zero-knowledge proof that the sender holds the key of some slot registered in the
//! round's census, bound to one staging request and to a one-time tag. The server checks the public
//! inputs here, cheaply, before it spends a proof verification on them.

use alloy::{
    primitives::{keccak256, Address, B256, U256},
    sol_types::SolValue,
};
use eyre::{ensure, Result};

/// The domain of the request digest a pass signs.
const STAGING_DOMAIN: &str = "CRISP_STAGING_V1";

/// The number of public inputs of the circuit:
/// `census_root, round_id, request_digest_hi, request_digest_lo, max_requests, tag`.
pub const STAGING_PASS_PUBLIC_INPUTS: usize = 6;

/// The BN254 scalar field order; a public input must be below it to be a field element.
const MODULUS: U256 = U256::from_limbs([
    0x43e1f593f0000001,
    0x2833e84879b97091,
    0xb85045b68181585d,
    0x30644e72e131a029,
]);

/// The digest a staging pass signs and exposes as `request_digest`:
/// `keccak256(abi.encode("CRISP_STAGING_V1", chainId, program, e3Id, ciphertextCommitment, slot,
/// parentIndexPlusOne))`. It binds the pass to one request, so it cannot be replayed for other
/// bytes, another slot or another round.
pub fn staging_request_digest(
    chain_id: u64,
    program: Address,
    e3_id: U256,
    ciphertext_commitment: B256,
    slot: Address,
    parent_index_plus_one: u64,
) -> B256 {
    keccak256(
        (
            STAGING_DOMAIN,
            U256::from(chain_id),
            program,
            e3_id,
            ciphertext_commitment,
            slot,
            U256::from(parent_index_plus_one),
        )
            .abi_encode_params(),
    )
}

/// The public inputs of a pass.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct StagingPassStatement {
    /// A root of the tree the pass proves membership of: the census for `staging_pass`, the
    /// staging-key tree for `staging_pass_votes`.
    pub census_root: U256,
    /// The contract's round id, the low 96 bits of the E3 id.
    pub round_id: U256,
    /// The digest the slot key signed.
    pub request_digest: B256,
    /// The pass limit the proof was made for.
    pub max_requests: u32,
    /// The one-time tag: `Poseidon(x, y, round, k)` of the slot key.
    pub tag: B256,
}

impl StagingPassStatement {
    /// Read the public inputs the SDK sends, 32-byte big-endian hex fields in the circuit's order,
    /// and the 32 raw bytes of each as the verifier takes them.
    pub fn parse(fields: &[String]) -> Result<(Self, Vec<u8>)> {
        ensure!(
            fields.len() == STAGING_PASS_PUBLIC_INPUTS,
            "a staging pass has {} public inputs, expected {STAGING_PASS_PUBLIC_INPUTS}",
            fields.len()
        );
        let mut raw = Vec::with_capacity(32 * STAGING_PASS_PUBLIC_INPUTS);
        let mut values = [U256::ZERO; STAGING_PASS_PUBLIC_INPUTS];
        for (value, field) in values.iter_mut().zip(fields) {
            let bytes = hex::decode(field.strip_prefix("0x").unwrap_or(field))
                .map_err(|_| eyre::eyre!("a staging pass public input is not hex"))?;
            ensure!(
                bytes.len() == 32,
                "a staging pass public input is not 32 bytes"
            );
            *value = U256::from_be_slice(&bytes);
            ensure!(
                *value < MODULUS,
                "a staging pass public input is not a field element"
            );
            raw.extend_from_slice(&bytes);
        }
        let [census_root, round_id, hi, lo, max_requests, tag] = values;
        ensure!(
            hi.bit_len() <= 128 && lo.bit_len() <= 128,
            "the request digest halves are wider than 128 bits"
        );
        let mut digest = [0u8; 32];
        digest[..16].copy_from_slice(&hi.to_be_bytes::<32>()[16..]);
        digest[16..].copy_from_slice(&lo.to_be_bytes::<32>()[16..]);
        ensure!(
            max_requests.bit_len() <= 32,
            "max_requests does not fit in a u32"
        );

        Ok((
            Self {
                census_root,
                round_id,
                request_digest: B256::from(digest),
                max_requests: max_requests.to::<u32>(),
                tag: B256::from(tag.to_be_bytes::<32>()),
            },
            raw,
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy::primitives::{address, b256};

    /// The vector `extensions/aztec/sdk/tests/staging-pass.test.ts` pins for the same request.
    #[test]
    fn the_request_digest_is_the_one_the_sdk_signs() {
        let digest = staging_request_digest(
            11_155_111,
            address!("0x25Df8D3C04D67efb6198E215963d19a8d119ADFF"),
            U256::from_str_radix(
                "dfa59d66c173a00643ebe80e172af5a8cf244b30000000000000000000000007",
                16,
            )
            .unwrap(),
            b256!("0x0000000000000000000000000000000000000000000000000000000000001234"),
            address!("0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC"),
            3,
        );
        assert_eq!(
            digest,
            b256!("0xca0aaea375f27d277735c8c4aa967c4d37bb594235dc9af4c7f055700fc54acf")
        );
    }

    fn fields() -> Vec<String> {
        let field = |value: U256| format!("0x{}", hex::encode(value.to_be_bytes::<32>()));
        [1u64, 7, 0x0102, 0x0304, 16, 99]
            .map(|value| field(U256::from(value)))
            .to_vec()
    }

    #[test]
    fn public_inputs_are_read_in_the_circuits_order() {
        let (statement, raw) = StagingPassStatement::parse(&fields()).unwrap();
        assert_eq!(statement.census_root, U256::from(1));
        assert_eq!(statement.round_id, U256::from(7));
        assert_eq!(statement.max_requests, 16);
        assert_eq!(
            statement.tag,
            B256::from(U256::from(99).to_be_bytes::<32>())
        );
        // The halves are the high and the low 16 bytes of the digest.
        assert_eq!(statement.request_digest[14..16], [0x01, 0x02]);
        assert_eq!(statement.request_digest[30..32], [0x03, 0x04]);
        assert_eq!(raw.len(), 192);
    }

    #[test]
    fn malformed_public_inputs_are_refused() {
        let ok = fields();
        assert!(StagingPassStatement::parse(&ok[..5]).is_err());

        let mut not_hex = ok.clone();
        not_hex[0] = "0xzz".into();
        assert!(StagingPassStatement::parse(&not_hex).is_err());

        let mut short = ok.clone();
        short[1] = "0x07".into();
        assert!(StagingPassStatement::parse(&short).is_err());

        let mut not_a_field = ok.clone();
        not_a_field[5] = format!("0x{}", "ff".repeat(32));
        assert!(StagingPassStatement::parse(&not_a_field).is_err());

        let mut wide_half = ok.clone();
        wide_half[2] = format!(
            "0x{}",
            hex::encode((U256::from(1u64) << 128usize).to_be_bytes::<32>())
        );
        assert!(StagingPassStatement::parse(&wide_half).is_err());

        let mut wide_limit = ok;
        wide_limit[4] = format!(
            "0x{}",
            hex::encode((U256::from(1u64) << 32usize).to_be_bytes::<32>())
        );
        assert!(StagingPassStatement::parse(&wide_limit).is_err());
    }
}
