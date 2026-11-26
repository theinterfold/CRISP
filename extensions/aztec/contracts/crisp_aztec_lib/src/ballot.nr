//! What `cast` enforces on the two base proofs of a ballot besides verifying them.
//!
//! The voter proves the Interfold `user_data_encryption` circuit (both legs of the BFV encryption over one `u`, with the
//! committee key's second component fixed to the protocol CRS) and the crisp ballot circuit. L1 folds them with one
//! aggregation circuit (`crisp_fold`, `circuits/bin/fold`); `cast` verifies the two proofs itself, so it has to make the
//! checks that circuit makes:
//!
//! | # | Check | Replaces |
//! | - | ----- | -------- |
//! | 1 | `user_data_encryption` and crisp verify against the pinned verification keys (hash of each key = the config) | `crisp_fold`: `verify_honk_proof_non_zk` x2, and `chain_key_hash` in the set of allowed hashes |
//! | 2 | crisp's `ct_commitment` is the encryption proof's | `crisp_fold`: `ct_commitment == user_data_encryption_public_inputs[1]` |
//! | 3 | crisp's `k1_commitment` is the encryption proof's | `crisp_fold`: `k1_commitment == user_data_encryption_public_inputs[2]` |
//! | 4 | the encryption proof's `pk_commitment` is the round's committee key | `crisp_fold` returned `user_data_encryption_public_inputs[0]`, which the L1 program compares with the committee key |
//!
//! The ciphertext's two legs sharing one `u`, the `u`, `e0`, `e1` bounds and the key commitment being over the CRS are
//! constraints of `user_data_encryption` itself now; there is no `u` commitment to compare. The rest of the fold's
//! public inputs (previous commitment, digest, slot, census root, first-vote flag, number of options, final ciphertext
//! commitment) are values `cast` already knows, as before; they are the crisp circuit's.

/// Public inputs of the crisp ballot circuit: `prev_ct_commitment, digest_hi, digest_lo, slot_address, merkle_root,
/// is_first_vote, num_options, final_ct_commitment`, then its return values `ct_commitment, k1_commitment`.
pub global CRISP_PUBLIC_INPUTS: u32 = 10;

/// Public inputs of `user_data_encryption`: `pk_commitment, ct_commitment, k1_commitment`.
pub global ENCRYPTION_PUBLIC_INPUTS: u32 = 3;

/// Checks 2 to 4 of the table above, and the public inputs of the crisp proof they leave: `values` are the first eight
/// (`prev_ct_commitment` to `final_ct_commitment`), the last two are the encryption proof's.
pub fn crisp_public_inputs(
    encryption_public_inputs: [Field; ENCRYPTION_PUBLIC_INPUTS],
    committee_key: Field,
    values: [Field; 8],
) -> [Field; CRISP_PUBLIC_INPUTS] {
    assert_eq(encryption_public_inputs[0], committee_key, "ballot is encrypted to another committee key");

    [
        values[0],
        values[1],
        values[2],
        values[3],
        values[4],
        values[5],
        values[6],
        values[7],
        encryption_public_inputs[1],
        encryption_public_inputs[2],
    ]
}
