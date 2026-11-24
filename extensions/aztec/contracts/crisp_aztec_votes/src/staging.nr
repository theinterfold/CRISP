//! The staging key of `CrispAztecVotes`: a per-round secret a slot's wallet binds once, from its signature of
//! `StagingKey(uint256 e3Id)`. The staging-pass circuit (`staging_pass_votes`) proves membership of the commitment in the
//! round's staging tree without revealing which slot it belongs to.

use crisp_aztec_lib::{
    constants::STAGING_KEY_TYPEHASH,
    hashing::{bytes_to_field, eip712_digest, put, to_halves},
};
use keccak256::keccak256;
use poseidon::{poseidon::bn254::hash_2, poseidon2::Poseidon2};

/// The EIP-712 digest of `StagingKey(uint256 e3Id)` in the ballot domain; `e3_id` is the full 32-byte E3 id.
pub fn staging_key_digest(domain_separator: [u8; 32], e3_id: [u8; 32]) -> [u8; 32] {
    let mut encoded = [0; 64];
    encoded = put(encoded, 0, STAGING_KEY_TYPEHASH);
    encoded = put(encoded, 32, e3_id);
    eip712_digest(domain_separator, keccak256(encoded, 64))
}

/// The Ethereum address of an uncompressed public key, `keccak256(x || y)[12..]`, as a field.
pub fn address_of(public_key_x: [u8; 32], public_key_y: [u8; 32]) -> Field {
    let mut key = [0; 64];
    key = put(key, 0, public_key_x);
    key = put(key, 32, public_key_y);
    let hash = keccak256(key, 64);
    let mut address = [0; 20];
    for i in 0..20 {
        address[i] = hash[i + 12];
    }
    bytes_to_field(address)
}

/// The staging secret: Poseidon2 (the aztec-nr sponge, `Poseidon2::hash`) of the signature's `r` and `s` as four 128-bit
/// big-endian limbs `[r_hi, r_lo, s_hi, s_lo]`.
pub fn staging_secret(signature: [u8; 64]) -> Field {
    let mut r = [0; 32];
    let mut s = [0; 32];
    for i in 0..32 {
        r[i] = signature[i];
        s[i] = signature[i + 32];
    }
    let r_limbs = to_halves(r);
    let s_limbs = to_halves(s);
    Poseidon2::hash([r_limbs[0], r_limbs[1], s_limbs[0], s_limbs[1]], 4)
}

/// The staging tree's leaf: circom Poseidon `hash_2([secret, round_id])`, the hash of the census tree.
pub fn staging_commitment(secret: Field, round_id: Field) -> Field {
    hash_2([secret, round_id])
}
