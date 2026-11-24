// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

//! # Staging pass for the votes kind
//!
//! An anonymous, rate-limited ticket to stage one ciphertext with the CRISP server of a round whose
//! voters are enrolled governance slots (wallet addresses). It proves only
//!
//!   "I hold the staging secret bound for SOME slot of this round, and this is its k-th pass"
//!
//! and reveals neither the slot nor the secret.
//!
//! The pass of `staging_pass` hashes the slot PUBLIC KEY, which is no secret for a wallet address
//! (any past transaction reveals it), so the server could compute the tags of every enrolled slot and
//! link a staging request to its sender. Here the tag is keyed by a per-round staging secret that
//! only the slot owner knows: the Aztec `bind_staging_key` derives it from the owner's signature and
//! inserts the commitment `hash_2([secret, round_id])` into the round's staging tree.
//!
//! # Statement
//!
//! Private: the staging `secret`, the staging-tree path and the pass counter `k`.
//! Public, in this order: `staging_root`, `round_id`, `request_digest_hi`, `request_digest_lo`,
//! `max_requests`, `tag`. The circuit proves
//!
//! 1. the leaf `hash_2([secret, round_id])` is in the staging tree with root `staging_root`
//!    (the census LeanIMT path code of `crisp_lib`);
//! 2. `k < max_requests`;
//! 3. `tag = hash_3([secret, round_id, k])`.
//!
//! `request_digest_hi/lo` (the server's raw `staging_request_digest`, two 128-bit halves) is only
//! bound as a public input: the proof is made for one request, it signs nothing.

use crisp_lib::merkle_tree::get_merkle_root;
use poseidon::poseidon::bn254::hash_3;

/// The rate-limit tag of the `k`-th pass of the staging secret in round `round_id`.
fn pass_tag(secret: Field, round_id: Field, k: u32) -> Field {
    hash_3([secret, round_id, k as Field])
}

fn verify_pass(
    secret: Field,
    merkle_proof_length: u32,
    merkle_proof_indices: [bool; 20],
    merkle_proof_siblings: [Field; 20],
    k: u32,
    staging_root: Field,
    round_id: Field,
    request_digest_hi: Field,
    request_digest_lo: Field,
    max_requests: u32,
    tag: Field,
) {
    // The digest halves are only bound as public inputs; they must be 128-bit limbs.
    request_digest_hi.assert_max_bit_size::<128>();
    request_digest_lo.assert_max_bit_size::<128>();

    // `get_merkle_root` hashes `hash_2([first, second])`: with `(secret, round_id)` that is
    // the commitment `bind_staging_key` inserts.
    let root = get_merkle_root(
        secret,
        round_id,
        merkle_proof_length,
        merkle_proof_indices,
        merkle_proof_siblings,
    );
    assert(root == staging_root);

    assert(k < max_requests);
    assert(tag == pass_tag(secret, round_id, k));
}

fn main(
    // The staging secret and the path of its commitment in the staging tree.
    secret: Field,
    merkle_proof_length: u32,
    merkle_proof_indices: [bool; 20],
    merkle_proof_siblings: [Field; 20],
    // The pass counter, `0 <= k < max_requests`.
    k: u32,
    staging_root: pub Field,
    round_id: pub Field,
    request_digest_hi: pub Field,
    request_digest_lo: pub Field,
    max_requests: pub u32,
    tag: pub Field,
) {
    verify_pass(
        secret,
        merkle_proof_length,
        merkle_proof_indices,
        merkle_proof_siblings,
        k,
        staging_root,
        round_id,
        request_digest_hi,
        request_digest_lo,
        max_requests,
        tag,
    );
}

global SECRET: Field = 0x1f2e3d4c5b6a79880123456789abcdef;
global NEIGHBOUR_SECRET: Field = 0x0badc0ffee0ddf00d5eed5eed5eed5ee;
global ROUND_ID: Field = 7;
global MAX_REQUESTS: u32 = 16;
global DIGEST_HI: Field = 0x437e9da4a2a538f29bd671c453c6e424;
global DIGEST_LO: Field = 0xae689857a76c4022eaa17a372c3e9737;

/// A staging tree of two commitments, `SECRET`'s at index 0 and `NEIGHBOUR_SECRET`'s at index 1,
/// both for `leaf_round`, and the path of the first.
fn staging_tree(leaf_round: Field) -> (Field, [bool; 20], [Field; 20]) {
    let mut siblings = [0; 20];
    siblings[0] = poseidon::poseidon::bn254::hash_2([NEIGHBOUR_SECRET, leaf_round]);
    let root = get_merkle_root(SECRET, leaf_round, 1, [false; 20], siblings);
    (root, [false; 20], siblings)
}

fn prove_with(secret: Field, leaf_round: Field, k: u32, max_requests: u32, tag: Field) {
    let (root, indices, siblings) = staging_tree(leaf_round);
    verify_pass(
        secret,
        1,
        indices,
        siblings,
        k,
        root,
        ROUND_ID,
        DIGEST_HI,
        DIGEST_LO,
        max_requests,
        tag,
    );
}

#[test]
fn test_valid_pass() {
    prove_with(SECRET, ROUND_ID, 3, MAX_REQUESTS, pass_tag(SECRET, ROUND_ID, 3));
}

#[test]
fn test_valid_pass_last_counter() {
    prove_with(
        SECRET,
        ROUND_ID,
        MAX_REQUESTS - 1,
        MAX_REQUESTS,
        pass_tag(SECRET, ROUND_ID, MAX_REQUESTS - 1),
    );
}

/// Any bound slot may stage: the second member's pass verifies against the same root.
#[test]
fn test_valid_pass_other_member() {
    let (root, _, _) = staging_tree(ROUND_ID);
    let mut indices = [false; 20];
    indices[0] = true;
    let mut siblings = [0; 20];
    siblings[0] = poseidon::poseidon::bn254::hash_2([SECRET, ROUND_ID]);
    verify_pass(
        NEIGHBOUR_SECRET,
        1,
        indices,
        siblings,
        0,
        root,
        ROUND_ID,
        DIGEST_HI,
        DIGEST_LO,
        MAX_REQUESTS,
        pass_tag(NEIGHBOUR_SECRET, ROUND_ID, 0),
    );
}

/// A secret that was never bound: its commitment is not in the tree.
#[test(should_fail)]
fn test_fail_wrong_secret() {
    prove_with(SECRET + 1, ROUND_ID, 0, MAX_REQUESTS, pass_tag(SECRET + 1, ROUND_ID, 0));
}

/// The secret is bound, but for another round: the tree's leaf is not the one of `round_id`.
#[test(should_fail)]
fn test_fail_other_rounds_leaf() {
    prove_with(SECRET, ROUND_ID + 1, 0, MAX_REQUESTS, pass_tag(SECRET, ROUND_ID, 0));
}

#[test(should_fail)]
fn test_fail_counter_at_limit() {
    prove_with(
        SECRET,
        ROUND_ID,
        MAX_REQUESTS,
        MAX_REQUESTS,
        pass_tag(SECRET, ROUND_ID, MAX_REQUESTS),
    );
}

/// The tag is fixed by the secret, the round and the counter: it cannot be chosen.
#[test(should_fail)]
fn test_fail_wrong_tag() {
    prove_with(SECRET, ROUND_ID, 0, MAX_REQUESTS, pass_tag(SECRET, ROUND_ID, 1));
}

/// The digest halves are 128-bit limbs.
#[test(should_fail)]
fn test_fail_digest_limb_too_wide() {
    let (root, indices, siblings) = staging_tree(ROUND_ID);
    verify_pass(
        SECRET,
        1,
        indices,
        siblings,
        0,
        root,
        ROUND_ID,
        0x100000000000000000000000000000000,
        DIGEST_LO,
        MAX_REQUESTS,
        pass_tag(SECRET, ROUND_ID, 0),
    );
}
