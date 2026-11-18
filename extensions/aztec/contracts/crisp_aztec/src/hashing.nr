// Byte-level encodings shared with the L1 `CRISPProgram` family. Every function here reproduces a Solidity
// expression; the tests pin each one to a vector produced by that Solidity code.

use crate::constants::{
    BALLOT_TYPEHASH, INPUT_AVAILABILITY_TYPEHASH, INPUT_ID_TAG, MESSAGE_KEY, MESSAGE_ROOT, MESSAGE_ROUND,
};
use aztec::protocol::{address::EthAddress, hash::sha256_to_field, traits::ToField};
use keccak256::keccak256;
use sha256::digest as sha256_digest;

/// The 32-byte Interfold `e3Id` of a round: the Interfold address in the high 20 bytes, the round id in the low 12.
/// `Interfold.request` numbers E3s from `uint160(interfold) << 96`, which does not fit a field, so the contract
/// keys everything by the round id and rebuilds the full id wherever L1, the server or the SDK hash it.
/// Fails for a round id of 96 bits or more.
pub fn full_e3_id(interfold: EthAddress, round_id: Field) -> [u8; 32] {
    let mut e3_id = [0; 32];
    e3_id = put(e3_id, 0, interfold.to_field().to_be_bytes::<20>());
    e3_id = put(e3_id, 20, round_id.to_be_bytes::<12>());
    e3_id
}

/// A field as an ABI word (`uint256`, `address`, `uint64`, ...).
pub fn word(value: Field) -> [u8; 32] {
    value.to_be_bytes()
}

fn put<let N: u32, let M: u32>(mut buf: [u8; N], offset: u32, bytes: [u8; M]) -> [u8; N] {
    for i in 0..M {
        buf[offset + i] = bytes[i];
    }
    buf
}

/// Big-endian bytes read as an integer mod p.
pub fn bytes_to_field<let N: u32>(bytes: [u8; N]) -> Field {
    let mut acc = 0;
    for i in 0..N {
        acc = acc * 256 + bytes[i] as Field;
    }
    acc
}

/// A bytes32 as two 128-bit big-endian halves, the form a digest takes as circuit public inputs and in storage.
pub fn to_halves(bytes: [u8; 32]) -> [Field; 2] {
    let mut hi = [0; 16];
    let mut lo = [0; 16];
    for i in 0..16 {
        hi[i] = bytes[i];
        lo[i] = bytes[i + 16];
    }
    [bytes_to_field(hi), bytes_to_field(lo)]
}

/// Inverse of `to_halves`; a half above 128 bits has no encoding and fails.
pub fn from_halves(halves: [Field; 2]) -> [u8; 32] {
    let hi: [u8; 16] = halves[0].to_be_bytes();
    let lo: [u8; 16] = halves[1].to_be_bytes();
    let mut bytes = [0; 32];
    for i in 0..16 {
        bytes[i] = hi[i];
        bytes[i + 16] = lo[i];
    }
    bytes
}

fn eip712_digest(domain_separator: [u8; 32], struct_hash: [u8; 32]) -> [u8; 32] {
    let mut message = [0; 66];
    message[0] = 0x19;
    message[1] = 0x01;
    message = put(message, 2, domain_separator);
    message = put(message, 34, struct_hash);
    keccak256(message, 66)
}

/// `CRISPProgram.ballotDigest`: the EIP-712 digest of `Ballot(uint256 e3Id,address slot,bytes32 ciphertextCommitment)`.
pub fn ballot_digest(domain_separator: [u8; 32], e3_id: [u8; 32], slot: Field, ct_commitment: Field) -> [u8; 32] {
    let mut encoded = [0; 128];
    encoded = put(encoded, 0, BALLOT_TYPEHASH);
    encoded = put(encoded, 32, e3_id);
    encoded = put(encoded, 64, word(slot));
    encoded = put(encoded, 96, word(ct_commitment));
    eip712_digest(domain_separator, keccak256(encoded, 128))
}

/// `CRISPProgram.inputId`: `keccak256(abi.encode("CRISP_INPUT_V1", l1Program, e3Id, encryptedVoteHash, commitment,
/// slot, parentIndexPlusOne))`.
pub fn input_id(
    l1_program: EthAddress,
    e3_id: [u8; 32],
    encrypted_vote_hash: [u8; 32],
    ct_commitment: Field,
    slot: Field,
    parent_index_plus_one: u32,
) -> [u8; 32] {
    // Seven head words, then the dynamic string: its length word and its right-padded bytes.
    let mut encoded = [0; 288];
    encoded = put(encoded, 0, word(7 * 32));
    encoded = put(encoded, 32, word(l1_program.to_field()));
    encoded = put(encoded, 64, e3_id);
    encoded = put(encoded, 96, encrypted_vote_hash);
    encoded = put(encoded, 128, word(ct_commitment));
    encoded = put(encoded, 160, word(slot));
    encoded = put(encoded, 192, word(parent_index_plus_one as Field));
    encoded = put(encoded, 224, word(14));
    encoded = put(encoded, 256, INPUT_ID_TAG);
    keccak256(encoded, 288)
}

/// `CRISPProgram.inputAvailabilityDigest`: the EIP-712 digest the availability service signs.
pub fn availability_digest(
    domain_separator: [u8; 32],
    e3_id: [u8; 32],
    input_id: [u8; 32],
    expires_at: u64,
) -> [u8; 32] {
    let mut encoded = [0; 128];
    encoded = put(encoded, 0, INPUT_AVAILABILITY_TYPEHASH);
    encoded = put(encoded, 32, e3_id);
    encoded = put(encoded, 64, input_id);
    encoded = put(encoded, 96, word(expires_at as Field));
    eip712_digest(domain_separator, keccak256(encoded, 128))
}

/// `CRISPProgram.inputLeaf`: `uint256(sha256(abi.encodePacked(encryptedVoteHash, commitment, slot,
/// parentIndexPlusOne))) % SNARK_SCALAR_FIELD`, with `slot` as 20 bytes and the parent as 5 (`uint40`).
pub fn input_leaf(
    encrypted_vote_hash: [u8; 32],
    ct_commitment: Field,
    slot: Field,
    parent_index_plus_one: u32,
) -> Field {
    let slot_bytes: [u8; 20] = slot.to_be_bytes();
    let parent_bytes: [u8; 5] = (parent_index_plus_one as Field).to_be_bytes();
    let mut preimage = [0; 89];
    preimage = put(preimage, 0, encrypted_vote_hash);
    preimage = put(preimage, 32, word(ct_commitment));
    preimage = put(preimage, 64, slot_bytes);
    preimage = put(preimage, 84, parent_bytes);
    bytes_to_field(sha256_digest(preimage))
}

/// Content of the ROUND message `Interfold.request` sends from L1. Word 2 is the round id (`uint96(e3Id)`).
pub fn round_content(
    round_id: Field,
    num_options: Field,
    credits: Field,
    input_start: u64,
    input_end: u64,
    input_limit: u32,
    scope_hash: Field,
    min_age: u8,
    allow_mock_documents: bool,
    nationality_mode: u8,
    nationality_commitment: Field,
) -> Field {
    let words = [
        MESSAGE_ROUND,
        round_id,
        num_options,
        credits,
        input_start as Field,
        input_end as Field,
        input_limit as Field,
        scope_hash,
        min_age as Field,
        allow_mock_documents as Field,
        nationality_mode as Field,
        nationality_commitment,
    ];
    let mut encoded = [0; 384];
    for i in 0..12 {
        encoded = put(encoded, i * 32, word(words[i]));
    }
    sha256_to_field(encoded)
}

/// Content of the KEY message `publishCommitteeKey` sends from L1.
pub fn key_content(round_id: Field, committee_public_key: Field) -> Field {
    let mut encoded = [0; 96];
    encoded = put(encoded, 0, word(MESSAGE_KEY));
    encoded = put(encoded, 32, word(round_id));
    encoded = put(encoded, 64, word(committee_public_key));
    sha256_to_field(encoded)
}

/// Content of the ROOT message `close_round` sends to L1.
pub fn root_content(round_id: Field, input_root: Field, num_inputs: u32) -> Field {
    let mut encoded = [0; 128];
    encoded = put(encoded, 0, word(MESSAGE_ROOT));
    encoded = put(encoded, 32, word(round_id));
    encoded = put(encoded, 64, word(input_root));
    encoded = put(encoded, 96, word(num_inputs as Field));
    sha256_to_field(encoded)
}
