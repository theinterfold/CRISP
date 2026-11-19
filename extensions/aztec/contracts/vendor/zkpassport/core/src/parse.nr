use crate::constants::{
    PI_CERT_ROOT, PI_CIRCUIT_ROOT, PI_CURRENT_DATE, PI_PARAMS_START, PI_SCOPE, PI_SUBSCOPE,
};

pub struct PublicInputs<let K: u32> {
    pub certificate_registry_root: Field,
    pub circuit_registry_root: Field,
    pub current_date: u64,
    pub domain: Field,
    pub scope: Field,
    pub param_commitments: [Field; K - 3],
    pub nullifier_type: u8,
    pub scoped_nullifier: Field,
    pub oprf_pk_hash: Field,
    pub verification_method: Field,
}

pub fn parse_public_inputs<let K: u32>(public_inputs: [Field; K + 6]) -> PublicInputs<K> {
    let current_date_f = public_inputs[PI_CURRENT_DATE];
    let current_date = current_date_f as u64;
    assert(current_date as Field == current_date_f, "current_date out of range");

    let nullifier_type_f = public_inputs[K + 6 - 4];
    let nullifier_type = nullifier_type_f as u8;
    assert(nullifier_type as Field == nullifier_type_f, "nullifier_type out of range");

    let mut param_commitments = [0; K - 3];
    for i in 0..K - 3 {
        param_commitments[i] = public_inputs[PI_PARAMS_START + i];
    }

    PublicInputs {
        certificate_registry_root: public_inputs[PI_CERT_ROOT],
        circuit_registry_root: public_inputs[PI_CIRCUIT_ROOT],
        current_date,
        domain: public_inputs[PI_SCOPE],
        scope: public_inputs[PI_SUBSCOPE],
        param_commitments,
        nullifier_type,
        scoped_nullifier: public_inputs[K + 6 - 3],
        oprf_pk_hash: public_inputs[K + 6 - 2],
        verification_method: public_inputs[K + 6 - 1],
    }
}
