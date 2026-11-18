// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

//! # Staging pass
//!
//! An anonymous, rate-limited ticket to stage one ciphertext with the CRISP server of a round
//! whose inputs are collected on an L2.
//!
//! The server attests availability of a ciphertext before the L2 `cast`, so without a ticket anyone
//! could fill its storage with bytes that are never cast. Asking for the slot's signature would let
//! the server tell a vote (signed by the slot) from a mask (a registered slot is masked by anybody),
//! which the ballot design keeps indistinguishable. This circuit proves only
//!
//!   "I hold the key of SOME slot registered in this round's census, and this is its k-th pass"
//!
//! and reveals neither the slot nor the key. A voter stages a mask with the pass of its own slot,
//! while the request names the slot being masked, so the server cannot tell a vote from a mask.
//!
//! # Statement
//!
//! Private: the slot public key `(x, y)`, an ECDSA secp256k1 signature, the census Merkle path, the
//! slot's `credits` and the pass counter `k`.
//!
//! Public: `census_root`, `round_id`, `request_digest` (as two 128-bit halves), `max_requests` and
//! `tag`. The circuit proves
//!
//! 1. the signature is valid for `(x, y)` over `request_digest`, which binds the pass to one staging
//!    request (see the server's `staging_request_digest`), so it cannot be replayed for other bytes;
//! 2. the leaf `Poseidon2(address(x, y), credits)` is in the census tree with root `census_root`.
//!    The leaf, the circom Poseidon and the LeanIMT path are the ballot circuit's (`crisp_lib`);
//! 3. `k < max_requests`;
//! 4. `tag = Poseidon6(x_hi, x_lo, y_hi, y_lo, round_id, k)`, each coordinate as two 128-bit limbs.
//!
//! # Rate limit and the unlinkability assumption
//!
//! The server keeps every tag of a round and refuses a repeat, so one slot stages at most
//! `max_requests` ciphertexts per round. The tag hashes the slot PUBLIC KEY, not its address.
//! The address is public (the registration and the census name it), so a tag over the address
//! could be linked to its slot by anyone. The public key is never published: votes' signatures are
//! private inputs of the ballot proof and the registration binds only the address. A tag is then
//! unlinkable to a slot unless the slot owner reveals a signature made with the key.

use crisp_lib::ecdsa::{address_to_field, derive_address, digest_from_halves, validate_signature};
use crisp_lib::merkle_tree::get_merkle_root;
use poseidon::poseidon::bn254::hash_6;

/// A big-endian 32-byte value as two 128-bit limbs, `(high, low)`.
fn limbs(bytes: [u8; 32]) -> (Field, Field) {
    let mut high: Field = 0;
    let mut low: Field = 0;
    for i in 0..16 {
        high = high * 256 + (bytes[i] as Field);
        low = low * 256 + (bytes[i + 16] as Field);
    }
    (high, low)
}

/// The rate-limit tag of the `k`-th pass of the slot key `(x, y)` in round `round_id`.
fn pass_tag(public_key_x: [u8; 32], public_key_y: [u8; 32], round_id: Field, k: u32) -> Field {
    let (x_hi, x_lo) = limbs(public_key_x);
    let (y_hi, y_lo) = limbs(public_key_y);
    hash_6([x_hi, x_lo, y_hi, y_lo, round_id, k as Field])
}

fn verify_pass(
    public_key_x: [u8; 32],
    public_key_y: [u8; 32],
    signature: [u8; 64],
    credits: Field,
    merkle_proof_length: u32,
    merkle_proof_indices: [bool; 20],
    merkle_proof_siblings: [Field; 20],
    k: u32,
    census_root: Field,
    round_id: Field,
    request_digest_hi: Field,
    request_digest_lo: Field,
    max_requests: u32,
    tag: Field,
) {
    // The digest is public, so the prover cannot choose the message the signature covers.
    let digest = digest_from_halves(request_digest_hi, request_digest_lo);
    assert(validate_signature(digest, public_key_x, public_key_y, signature));

    // The slot is whatever registered address the key hashes to.
    let slot = address_to_field(derive_address(public_key_x, public_key_y));
    let root = get_merkle_root(
        slot,
        credits,
        merkle_proof_length,
        merkle_proof_indices,
        merkle_proof_siblings,
    );
    assert(root == census_root);

    assert(k < max_requests);
    assert(tag == pass_tag(public_key_x, public_key_y, round_id, k));
}

fn main(
    // The slot key and its signature over the request digest.
    public_key_x: [u8; 32],
    public_key_y: [u8; 32],
    signature: [u8; 64],
    // The slot's census entry.
    credits: Field,
    merkle_proof_length: u32,
    merkle_proof_indices: [bool; 20],
    merkle_proof_siblings: [Field; 20],
    // The pass counter, `0 <= k < max_requests`.
    k: u32,
    census_root: pub Field,
    round_id: pub Field,
    request_digest_hi: pub Field,
    request_digest_lo: pub Field,
    max_requests: pub u32,
    tag: pub Field,
) {
    verify_pass(
        public_key_x,
        public_key_y,
        signature,
        credits,
        merkle_proof_length,
        merkle_proof_indices,
        merkle_proof_siblings,
        k,
        census_root,
        round_id,
        request_digest_hi,
        request_digest_lo,
        max_requests,
        tag,
    );
}

// The key, digest and signature are `crisp_lib::ecdsa`'s test vectors. The key is the hardhat
// account 0, address 0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266.
global KEY_X: [u8; 32] = [
    131, 24, 83, 91, 84, 16, 93, 74, 122, 174, 96, 192, 143, 196, 95, 150, 135, 24, 27, 79, 223,
    198, 37, 189, 26, 117, 63, 167, 57, 127, 237, 117,
];
global KEY_Y: [u8; 32] = [
    53, 71, 241, 28, 168, 105, 102, 70, 242, 243, 172, 176, 142, 49, 1, 106, 250, 194, 62, 99, 12,
    93, 17, 245, 159, 97, 254, 245, 123, 13, 42, 165,
];
global SIGNATURE: [u8; 64] = [
    78, 219, 63, 96, 214, 92, 16, 36, 108, 207, 133, 108, 3, 248, 122, 23, 192, 236, 210, 253, 206,
    125, 83, 124, 163, 54, 106, 125, 188, 223, 192, 39, 44, 76, 228, 107, 188, 221, 183, 124, 118,
    143, 228, 126, 216, 173, 160, 231, 62, 52, 188, 154, 110, 230, 183, 71, 36, 161, 171, 163, 213,
    62, 223, 152,
];
global DIGEST_HI: Field = 0x437e9da4a2a538f29bd671c453c6e424;
global DIGEST_LO: Field = 0xae689857a76c4022eaa17a372c3e9737;
/// The digest of `crisp_lib`'s `test_validate_signature_sdk_input`: valid for the key, but not the
/// one `SIGNATURE` covers.
global OTHER_DIGEST_HI: Field = 0xc8e862a25083f239fc4ce22d7fcecf27;
global OTHER_DIGEST_LO: Field = 0xce2cd3ab714379444efdca4f1d80824c;

global SLOT: Field = 0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266;
global CREDITS: Field = 1000;
global ROUND_ID: Field = 7;
global MAX_REQUESTS: u32 = 16;
/// Another registered member, the sibling of the key's leaf in a two-member census.
global NEIGHBOUR: Field = 0x70997970c51812dc3a010c7d01b50e0d17dc79c8;

/// A census of two members, `SLOT` at index 0 and `NEIGHBOUR` at index 1, and the path of the first.
fn census() -> (Field, [bool; 20], [Field; 20]) {
    let poseidon_2 = poseidon::poseidon::bn254::hash_2;
    let neighbour_leaf = poseidon_2([NEIGHBOUR, CREDITS]);
    let mut siblings = [0; 20];
    siblings[0] = neighbour_leaf;
    let root = get_merkle_root(SLOT, CREDITS, 1, [false; 20], siblings);
    (root, [false; 20], siblings)
}

fn prove_with(
    key_x: [u8; 32],
    key_y: [u8; 32],
    signature: [u8; 64],
    credits: Field,
    k: u32,
    digest_hi: Field,
    digest_lo: Field,
    max_requests: u32,
    tag: Field,
) {
    let (root, indices, siblings) = census();
    verify_pass(
        key_x,
        key_y,
        signature,
        credits,
        1,
        indices,
        siblings,
        k,
        root,
        ROUND_ID,
        digest_hi,
        digest_lo,
        max_requests,
        tag,
    );
}

fn valid_tag(k: u32) -> Field {
    pass_tag(KEY_X, KEY_Y, ROUND_ID, k)
}

#[test]
fn test_valid_pass() {
    prove_with(
        KEY_X,
        KEY_Y,
        SIGNATURE,
        CREDITS,
        3,
        DIGEST_HI,
        DIGEST_LO,
        MAX_REQUESTS,
        valid_tag(3),
    );
}

#[test]
fn test_valid_pass_last_counter() {
    prove_with(
        KEY_X,
        KEY_Y,
        SIGNATURE,
        CREDITS,
        MAX_REQUESTS - 1,
        DIGEST_HI,
        DIGEST_LO,
        MAX_REQUESTS,
        valid_tag(MAX_REQUESTS - 1),
    );
}

/// A key the signature was not made with.
#[test(should_fail)]
fn test_fail_wrong_key() {
    // A valid curve point that did not sign `SIGNATURE`: the signature check rejects it.
    let mut other_x = KEY_X;
    other_x[31] = other_x[31] ^ 1;
    prove_with(
        other_x,
        KEY_Y,
        SIGNATURE,
        CREDITS,
        0,
        DIGEST_HI,
        DIGEST_LO,
        MAX_REQUESTS,
        pass_tag(other_x, KEY_Y, ROUND_ID, 0),
    );
}

/// The key signed, but its slot is not in the census the pass names.
#[test(should_fail)]
fn test_fail_not_a_member() {
    // Credits the census does not hold for this slot change the leaf.
    prove_with(
        KEY_X,
        KEY_Y,
        SIGNATURE,
        CREDITS + 1,
        0,
        DIGEST_HI,
        DIGEST_LO,
        MAX_REQUESTS,
        valid_tag(0),
    );
}

#[test(should_fail)]
fn test_fail_member_of_another_census() {
    let (_, indices, siblings) = census();
    verify_pass(
        KEY_X,
        KEY_Y,
        SIGNATURE,
        CREDITS,
        1,
        indices,
        siblings,
        0,
        0x1234,
        ROUND_ID,
        DIGEST_HI,
        DIGEST_LO,
        MAX_REQUESTS,
        valid_tag(0),
    );
}

#[test(should_fail)]
fn test_fail_counter_at_limit() {
    prove_with(
        KEY_X,
        KEY_Y,
        SIGNATURE,
        CREDITS,
        MAX_REQUESTS,
        DIGEST_HI,
        DIGEST_LO,
        MAX_REQUESTS,
        valid_tag(MAX_REQUESTS),
    );
}

#[test(should_fail)]
fn test_fail_counter_above_limit() {
    prove_with(
        KEY_X,
        KEY_Y,
        SIGNATURE,
        CREDITS,
        255,
        DIGEST_HI,
        DIGEST_LO,
        MAX_REQUESTS,
        valid_tag(255),
    );
}

/// A signature covers one request: a pass cannot be replayed for another digest.
#[test(should_fail)]
fn test_fail_digest_binding() {
    prove_with(
        KEY_X,
        KEY_Y,
        SIGNATURE,
        CREDITS,
        0,
        OTHER_DIGEST_HI,
        OTHER_DIGEST_LO,
        MAX_REQUESTS,
        valid_tag(0),
    );
}

/// The tag is fixed by the key, the round and the counter: it cannot be chosen.
#[test(should_fail)]
fn test_fail_tag_not_derived() {
    prove_with(
        KEY_X,
        KEY_Y,
        SIGNATURE,
        CREDITS,
        0,
        DIGEST_HI,
        DIGEST_LO,
        MAX_REQUESTS,
        valid_tag(1),
    );
}

#[test]
fn test_tag_is_deterministic_and_separated() {
    assert(pass_tag(KEY_X, KEY_Y, ROUND_ID, 0) == pass_tag(KEY_X, KEY_Y, ROUND_ID, 0));
    assert(pass_tag(KEY_X, KEY_Y, ROUND_ID, 0) != pass_tag(KEY_X, KEY_Y, ROUND_ID, 1));
    assert(pass_tag(KEY_X, KEY_Y, ROUND_ID, 0) != pass_tag(KEY_X, KEY_Y, ROUND_ID + 1, 0));
    let mut other_y = KEY_Y;
    other_y[31] = other_y[31] ^ 1;
    assert(pass_tag(KEY_X, KEY_Y, ROUND_ID, 0) != pass_tag(KEY_X, other_y, ROUND_ID, 0));
}

#[test]
fn test_limbs() {
    let mut bytes = [0; 32];
    bytes[15] = 1;
    bytes[31] = 2;
    assert(limbs(bytes) == (1, 2));
}

// The hardhat account 1, `NEIGHBOUR`, signs `DIGEST` as well. It is the second member of the census.
global NEIGHBOUR_X: [u8; 32] = [
    186, 87, 52, 216, 247, 9, 23, 25, 71, 30, 127, 126, 214, 185, 223, 23, 13, 199, 12, 198, 97,
    202, 5, 230, 136, 96, 26, 217, 132, 240, 104, 176,
];
global NEIGHBOUR_Y: [u8; 32] = [
    214, 115, 81, 229, 240, 96, 115, 9, 36, 153, 51, 106, 176, 131, 158, 248, 165, 33, 175, 211, 52,
    229, 56, 7, 32, 95, 162, 240, 142, 236, 116, 244,
];
global NEIGHBOUR_SIGNATURE: [u8; 64] = [
    8, 195, 157, 85, 23, 136, 67, 161, 130, 206, 20, 1, 157, 4, 77, 181, 92, 233, 72, 196, 13, 219,
    253, 174, 166, 36, 165, 41, 137, 49, 227, 105, 14, 67, 108, 168, 88, 38, 218, 160, 13, 234, 185,
    59, 48, 139, 56, 179, 159, 198, 227, 84, 36, 69, 235, 80, 200, 192, 60, 125, 141, 107, 17, 96,
];

/// Any registered slot may stage: the pass of the second member verifies against the same root.
#[test]
fn test_valid_pass_other_member() {
    let (root, _, _) = census();
    let mut indices = [false; 20];
    indices[0] = true;
    let mut siblings = [0; 20];
    siblings[0] = poseidon::poseidon::bn254::hash_2([SLOT, CREDITS]);
    verify_pass(
        NEIGHBOUR_X,
        NEIGHBOUR_Y,
        NEIGHBOUR_SIGNATURE,
        CREDITS,
        1,
        indices,
        siblings,
        0,
        root,
        ROUND_ID,
        DIGEST_HI,
        DIGEST_LO,
        MAX_REQUESTS,
        pass_tag(NEIGHBOUR_X, NEIGHBOUR_Y, ROUND_ID, 0),
    );
}

/// A valid signature by a key whose slot the path does not lead to is no pass: the path is the
/// first member's, the key is the second's.
#[test(should_fail)]
fn test_fail_signer_is_not_the_member_of_the_path() {
    prove_with(
        NEIGHBOUR_X,
        NEIGHBOUR_Y,
        NEIGHBOUR_SIGNATURE,
        CREDITS,
        0,
        DIGEST_HI,
        DIGEST_LO,
        MAX_REQUESTS,
        pass_tag(NEIGHBOUR_X, NEIGHBOUR_Y, ROUND_ID, 0),
    );
}

/// A member's path with another member's signature.
#[test(should_fail)]
fn test_fail_signature_of_another_key() {
    prove_with(
        KEY_X,
        KEY_Y,
        NEIGHBOUR_SIGNATURE,
        CREDITS,
        0,
        DIGEST_HI,
        DIGEST_LO,
        MAX_REQUESTS,
        valid_tag(0),
    );
}
