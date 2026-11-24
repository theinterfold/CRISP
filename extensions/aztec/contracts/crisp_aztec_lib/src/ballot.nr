//! What `cast` enforces on the three base proofs of a ballot besides verifying them.
//!
//! The voter proves `user_data_encryption_ct0`, `user_data_encryption_ct1` and the crisp ballot circuit. L1 folds them
//! with two aggregation circuits (`user_data_encryption`, then `crisp_fold`); `cast` verifies the three proofs itself,
//! so it has to make the checks those circuits make. Every one is here, with the circuit line it replaces
//! (the Interfold `user_data_encryption` circuit, and `circuits/bin/fold`):
//!
//! | # | Check | Replaces |
//! | - | ----- | -------- |
//! | 1 | ct0, ct1 and crisp verify against the pinned verification keys (hash of each key = the config) | `user_data_encryption`: `verify_honk_proof_non_zk` x2 with `ct0_key_hash` / `ct1_key_hash` as public inputs; `crisp_fold`: x2, and `chain_key_hash` in the set of allowed hashes |
//! | 2 | ct0's `u_commitment` equals ct1's | `user_data_encryption`: `ct0_public_inputs[3] == ct1_public_inputs[2]` |
//! | 3 | the ciphertext commitment is `commit(ct0_commitment, ct1_commitment)`; crisp's `ct_commitment` is that value | `user_data_encryption`: `compute_commitment(.., DS_CIPHERTEXT)`; `crisp_fold`: `ct_commitment == user_data_encryption_public_inputs[3]` |
//! | 4 | crisp's `k1_commitment` is ct0's | `user_data_encryption`: `k1_commitment = ct0_public_inputs[2]`; `crisp_fold`: `k1_commitment == user_data_encryption_public_inputs[4]` |
//! | 5 | the committee key is `commit(pk0_commitment, pk1_commitment)` | `user_data_encryption`: `compute_commitment(.., DS_PK_AGGREGATION)`; the fold returned it as its last public input |
//!
//! The rest of the fold's public inputs (previous commitment, digest, slot, census root, first-vote flag, number of
//! options, final ciphertext commitment) are values `cast` already knows, as before; they are the crisp circuit's.

use interfold_lib::math::commitments::{compute_commitment, DS_CIPHERTEXT, DS_PK_AGGREGATION};

/// Public inputs of the crisp ballot circuit: `prev_ct_commitment, digest_hi, digest_lo, slot_address, merkle_root,
/// is_first_vote, num_options, final_ct_commitment`, then its return values `ct_commitment, k1_commitment`.
pub global CRISP_PUBLIC_INPUTS: u32 = 10;

/// Public inputs of `user_data_encryption_ct0`: `pk0_commitment, ct0_commitment, k1_commitment, u_commitment`.
pub global CT0_PUBLIC_INPUTS: u32 = 4;

/// Public inputs of `user_data_encryption_ct1`: `pk1_commitment, ct1_commitment, u_commitment`.
pub global CT1_PUBLIC_INPUTS: u32 = 3;

/// The committee key commitment the two encryption proofs bind the ballot to.
pub fn pk_commitment(ct0_public_inputs: [Field; CT0_PUBLIC_INPUTS], ct1_public_inputs: [Field; CT1_PUBLIC_INPUTS]) -> Field {
    compute_commitment([ct0_public_inputs[0], ct1_public_inputs[0]].as_vector(), DS_PK_AGGREGATION)
}

/// The commitment to the encrypted ballot, which the crisp circuit takes as `ct_commitment`.
pub fn ciphertext_commitment(
    ct0_public_inputs: [Field; CT0_PUBLIC_INPUTS],
    ct1_public_inputs: [Field; CT1_PUBLIC_INPUTS],
) -> Field {
    compute_commitment([ct0_public_inputs[1], ct1_public_inputs[1]].as_vector(), DS_CIPHERTEXT)
}

/// Checks 2 to 5 of the table above, and the public inputs of the crisp proof they leave: `values` are the first eight
/// (`prev_ct_commitment` to `final_ct_commitment`), the last two follow from the encryption proofs.
pub fn crisp_public_inputs(
    ct0_public_inputs: [Field; CT0_PUBLIC_INPUTS],
    ct1_public_inputs: [Field; CT1_PUBLIC_INPUTS],
    committee_key: Field,
    values: [Field; 8],
) -> [Field; CRISP_PUBLIC_INPUTS] {
    assert_eq(ct0_public_inputs[3], ct1_public_inputs[2], "ct0 and ct1 commit to different u");
    assert_eq(
        pk_commitment(ct0_public_inputs, ct1_public_inputs),
        committee_key,
        "ballot is encrypted to another committee key",
    );

    [
        values[0],
        values[1],
        values[2],
        values[3],
        values[4],
        values[5],
        values[6],
        values[7],
        ciphertext_commitment(ct0_public_inputs, ct1_public_inputs),
        ct0_public_inputs[2],
    ]
}
