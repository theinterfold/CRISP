// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

use alloy::primitives::{Address, B256, U256};
use eyre::{ensure, eyre, Result};

/// The first field of an `INPUT_COMMITTED` public log of `CrispAztec`. The node indexes a public
/// log by its first field, so this value is also the tag the server queries.
pub const INPUT_COMMITTED_TAG: u64 = 1;

/// The first field of a `MEMBER_REGISTERED` public log, `[TAG, round_id, census_index, slot,
/// census_leaf, census_root]`.
pub const MEMBER_REGISTERED_TAG: u64 = 2;

const ROOT_LOG_FIELDS: usize = 6;

/// The first field of a `STAGING_KEY_BOUND` public log of `CrispAztecVotes`, `[TAG, round_id,
/// index, slot, commitment, staging_root]`.
pub const STAGING_KEY_BOUND_TAG: u64 = 6;

/// `[TAG, round_id, index, slot, ct_commitment, vote_hash_hi, vote_hash_lo, parent_index_plus_one]`.
const INPUT_COMMITTED_FIELDS: usize = 8;

/// Width of the round id. An Interfold E3 id is `interfold address (160 bits) || sequence (96
/// bits)`, which does not fit a field element of the Aztec proving system, so the contract works
/// with the low 96 bits. One program is bound to one Interfold, so they identify the round.
const ROUND_ID_BITS: usize = 96;

/// The contract's round id of an Interfold E3 id.
pub fn round_id_of(e3_id: U256) -> U256 {
    e3_id & ((U256::from(1) << ROUND_ID_BITS) - U256::from(1))
}

/// The Interfold E3 id of a round of the contract, for the Interfold the program is bound to.
pub fn e3_id_of(interfold: Address, round_id: U256) -> U256 {
    (U256::from_be_slice(interfold.as_slice()) << ROUND_ID_BITS) | round_id
}

/// A decoded `INPUT_COMMITTED` log: the same facts the L1 `InputCommitted` event carries.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InputCommitted {
    /// The contract's id of the round: the low 96 bits of the Interfold E3 id (`round_id_of`).
    pub round_id: U256,
    pub index: u64,
    pub slot: Address,
    pub commitment: B256,
    /// `keccak256` of the ciphertext, which the contract stores as two `u128` halves.
    pub vote_hash: B256,
    pub parent_index_plus_one: u64,
}

impl InputCommitted {
    /// Decode the `logData` of a public log of the contract.
    ///
    /// The contract is immutable and emits one layout, so a log under this tag that does not match
    /// it is a wrong contract address or a wrong deployment, never a log to skip: skipping would
    /// drop an input and the round could not reach its root.
    pub fn decode(fields: &[U256]) -> Result<Self> {
        ensure!(
            fields.len() == INPUT_COMMITTED_FIELDS,
            "an INPUT_COMMITTED log has {} fields, expected {INPUT_COMMITTED_FIELDS}",
            fields.len()
        );
        ensure!(
            fields[0] == U256::from(INPUT_COMMITTED_TAG),
            "not an INPUT_COMMITTED log: tag {}",
            fields[0]
        );
        let narrow = |value: U256, bits: usize, name: &str| -> Result<U256> {
            ensure!(
                value.bit_len() <= bits,
                "{name} does not fit in {bits} bits"
            );
            Ok(value)
        };
        let to_u64 = |value: U256, bits: usize, name: &str| -> Result<u64> {
            Ok(narrow(value, bits, name)?.to::<u64>())
        };

        let slot = narrow(fields[3], 160, "slot")?.to_be_bytes::<32>();
        let hi = narrow(fields[5], 128, "vote hash high half")?.to_be_bytes::<32>();
        let lo = narrow(fields[6], 128, "vote hash low half")?.to_be_bytes::<32>();
        let mut vote_hash = [0u8; 32];
        vote_hash[..16].copy_from_slice(&hi[16..]);
        vote_hash[16..].copy_from_slice(&lo[16..]);

        Ok(Self {
            round_id: narrow(fields[1], ROUND_ID_BITS, "round id")?,
            index: to_u64(fields[2], 64, "index")?,
            slot: Address::from_slice(&slot[12..]),
            commitment: B256::from(fields[4].to_be_bytes::<32>()),
            vote_hash: B256::from(vote_hash),
            parent_index_plus_one: to_u64(fields[7], 40, "parent index")?,
        })
    }
}

/// A decoded `MEMBER_REGISTERED` log: the census root after one registration. A `STAGING_KEY_BOUND`
/// log has the same layout, and `census_root` is then its staging root.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MemberRegistered {
    /// The contract's id of the round (`round_id_of`).
    pub round_id: U256,
    pub census_root: U256,
}

impl MemberRegistered {
    /// Decode the `logData` of a public log under `tag` (`MEMBER_REGISTERED_TAG` or
    /// `STAGING_KEY_BOUND_TAG`). Like `InputCommitted`, a log of another shape is a wrong
    /// deployment, never one to skip.
    pub fn decode(fields: &[U256], tag: u64) -> Result<Self> {
        ensure!(
            fields.len() == ROOT_LOG_FIELDS,
            "a root log has {} fields, expected {ROOT_LOG_FIELDS}",
            fields.len()
        );
        ensure!(
            fields[0] == U256::from(tag),
            "not a log of tag {tag}: tag {}",
            fields[0]
        );
        ensure!(
            fields[1].bit_len() <= ROUND_ID_BITS,
            "round id does not fit in {ROUND_ID_BITS} bits"
        );

        Ok(Self {
            round_id: fields[1],
            census_root: fields[5],
        })
    }
}

/// Parse one field of a log as the node serializes it: a `0x`-prefixed hex string.
pub fn parse_field(value: &serde_json::Value) -> Result<U256> {
    let text = value
        .as_str()
        .ok_or_else(|| eyre!("a log field is not a string: {value}"))?;
    text.parse::<U256>()
        .map_err(|error| eyre!("a log field is not a number ({text}): {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy::primitives::{address, b256, keccak256};

    fn fields(vote_hash: B256) -> Vec<U256> {
        vec![
            U256::from(1),
            U256::from(7),
            U256::from(3),
            U256::from_be_slice(address!("0x00000000000000000000000000000000000000aa").as_slice()),
            U256::from(0x1234),
            U256::from_be_slice(&vote_hash[..16]),
            U256::from_be_slice(&vote_hash[16..]),
            U256::from(2),
        ]
    }

    #[test]
    fn a_log_decodes_to_the_fields_of_the_l1_event() {
        let hash = keccak256(b"ciphertext");

        let decoded = InputCommitted::decode(&fields(hash)).unwrap();

        assert_eq!(
            decoded,
            InputCommitted {
                round_id: U256::from(7),
                index: 3,
                slot: address!("0x00000000000000000000000000000000000000aa"),
                commitment: b256!(
                    "0x0000000000000000000000000000000000000000000000000000000000001234"
                ),
                vote_hash: hash,
                parent_index_plus_one: 2,
            }
        );
    }

    /// An Interfold E3 id is far above the BN254 modulus: the address sits in its top 160 bits.
    #[test]
    fn a_round_id_maps_to_the_full_interfold_e3_id_and_back() {
        let interfold = address!("0xdFa59d66c173A00643eBE80e172Af5a8Cf244b30");
        let e3_id = e3_id_of(interfold, U256::from(7));

        assert_eq!(
            e3_id,
            U256::from_str_radix(
                "dfa59d66c173a00643ebe80e172af5a8cf244b30000000000000000000000007",
                16
            )
            .unwrap()
        );
        let modulus = U256::from_str_radix(
            "30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001",
            16,
        )
        .unwrap();
        assert!(e3_id > modulus);
        assert_eq!(round_id_of(e3_id), U256::from(7));
    }

    #[test]
    fn a_round_id_wider_than_96_bits_is_refused() {
        let mut wide = fields(B256::ZERO);
        wide[1] = U256::from(1) << 96;
        assert!(InputCommitted::decode(&wide).is_err());
        wide[1] = (U256::from(1) << 96) - U256::from(1);
        assert!(InputCommitted::decode(&wide).is_ok());
    }

    #[test]
    fn a_vote_hash_with_leading_zero_bytes_survives_the_split() {
        let mut hash = [0u8; 32];
        hash[31] = 9;
        hash[15] = 1;
        let hash = B256::from(hash);

        assert_eq!(
            InputCommitted::decode(&fields(hash)).unwrap().vote_hash,
            hash
        );
    }

    #[test]
    fn a_member_log_decodes_to_its_round_and_root() {
        let fields = [2u64, 7, 3, 0xaa, 0x55, 0x66].map(U256::from).to_vec();
        assert_eq!(
            MemberRegistered::decode(&fields, MEMBER_REGISTERED_TAG).unwrap(),
            MemberRegistered {
                round_id: U256::from(7),
                census_root: U256::from(0x66),
            }
        );

        let mut wrong_tag = fields.clone();
        wrong_tag[0] = U256::from(1);
        assert!(MemberRegistered::decode(&wrong_tag, MEMBER_REGISTERED_TAG).is_err());
        assert!(MemberRegistered::decode(&fields[..5], MEMBER_REGISTERED_TAG).is_err());
        let mut wide = fields;
        wide[1] = U256::from(1) << 96;
        assert!(MemberRegistered::decode(&wide, MEMBER_REGISTERED_TAG).is_err());
    }

    #[test]
    fn a_log_of_another_shape_is_refused() {
        let mut other_tag = fields(B256::ZERO);
        other_tag[0] = U256::from(2);
        assert!(InputCommitted::decode(&other_tag).is_err());

        let mut short = fields(B256::ZERO);
        short.pop();
        assert!(InputCommitted::decode(&short).is_err());
    }

    #[test]
    fn a_value_wider_than_its_field_is_refused() {
        for (position, bits) in [(2, 64), (3, 160), (5, 128), (6, 128), (7, 40)] {
            let mut wide = fields(B256::ZERO);
            wide[position] = U256::from(1) << bits;
            assert!(
                InputCommitted::decode(&wide).is_err(),
                "field {position} accepted {bits}+1 bits"
            );
        }
    }

    #[test]
    fn a_node_field_is_a_prefixed_hex_string() {
        let field =
            serde_json::json!("0x000000000000000000000000000000000000000000000000000000000000002a");
        assert_eq!(parse_field(&field).unwrap(), U256::from(42));
        assert!(parse_field(&serde_json::json!(42)).is_err());
        assert!(parse_field(&serde_json::json!("0xzz")).is_err());
    }
}
