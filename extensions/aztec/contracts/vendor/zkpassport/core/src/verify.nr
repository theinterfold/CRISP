use crate::constants::{
    NULLIFIER_TYPE_NON_SALTED, NULLIFIER_TYPE_NON_SALTED_MOCK, NULLIFIER_TYPE_NONE,
    NULLIFIER_TYPE_SALTED, NULLIFIER_TYPE_SALTED_MOCK, PROOF_FIELDS, VERIFICATION_METHOD_ICAO_CHIP,
    VK_FIELDS,
};
use crate::parse::{parse_public_inputs, PublicInputs};
use bb_proof_verification::verify_honk_proof;
use poseidon::poseidon2::Poseidon2;

pub struct VerifiedOuterProof<let K: u32> {
    pub parsed: PublicInputs<K>,
    pub vk_hash: Field,
}

/// Does NOT check: registry roots, vk acceptance, OPRF binding, or freshness (needs a PrivateContext).
pub fn verify_outer_proof_core<let K: u32>(
    vk: [Field; VK_FIELDS],
    proof: [Field; PROOF_FIELDS],
    public_inputs: [Field; K + 6],
    domain: Field,
    scope: Field,
    dev_mode: bool,
    expected_commitments: [Field; K - 3],
) -> VerifiedOuterProof<K> {
    // key_hash is recomputed from the vk itself; bb independently asserts key_hash == poseidon2(vk),
    // so passing a self-computed hash is sound — and the registry pins WHICH vks are trusted.
    let vk_hash = Poseidon2::hash(vk, VK_FIELDS);
    verify_honk_proof(vk, proof, public_inputs, vk_hash);

    let parsed = parse_public_inputs::<K>(public_inputs);

    assert(parsed.domain == domain, "wrong service domain");
    assert(parsed.scope == scope, "wrong service scope");

    // CRISP PATCH (circuits 0.23.0): only an eMRTD chip read, signed by the issuing country, registers a voter. The
    // outer_count_K circuits' integrity proofs output nothing else, so this is defence in depth against a vk of
    // another scheme (a camera read, Aadhaar) ever being accepted by the registry.
    assert(
        parsed.verification_method == VERIFICATION_METHOD_ICAO_CHIP,
        "unsupported verification method",
    );

    let nt = parsed.nullifier_type;
    let is_standard = (nt == NULLIFIER_TYPE_NON_SALTED)
        | (nt == NULLIFIER_TYPE_SALTED)
        | (nt == NULLIFIER_TYPE_NONE);
    let is_mock = (nt == NULLIFIER_TYPE_NON_SALTED_MOCK) | (nt == NULLIFIER_TYPE_SALTED_MOCK);

    assert(is_standard | dev_mode, "nullifier type requires dev mode");

    // When the prover hides the private nullifier, the canonical circuit sets scoped_nullifier
    // to 0 (see calculate_scoped_nullifier in the circuits repo's commitment libs) and the
    // type to NULLIFIER_TYPE_NONE, except for a ZKR (mock) document, which keeps its mock type.
    // Salted and non-salted proofs must carry a nullifier.
    assert(
        (nt == NULLIFIER_TYPE_NONE) | is_mock | (parsed.scoped_nullifier != 0),
        "zero scoped nullifier",
    );

    // Every expected commitment must match a distinct param-commitment slot, in any order. The
    // order is not contractual — the prover decides the subproof (and thus slot) order and the
    // ZKPassport SDK itself matches by membership, so e.g. a {constraint, bind} pair may arrive
    // either way across SDK versions.
    let mut used = [false; K - 3];
    for i in 0..K - 3 {
        let mut found = false;
        for j in 0..K - 3 {
            let hit =
                (!used[j]) & (!found) & (parsed.param_commitments[j] == expected_commitments[i]);
            used[j] = used[j] | hit;
            found = found | hit;
        }
        assert(found, "param commitment mismatch");
    }

    VerifiedOuterProof { parsed, vk_hash }
}
