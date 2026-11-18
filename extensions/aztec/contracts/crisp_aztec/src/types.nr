use aztec::protocol::{address::{AztecAddress, EthAddress}, traits::{Deserialize, Packable, Serialize}};

/// Deployment-wide settings, fixed at construction. Bytes32 values are stored as two 128-bit halves.
#[derive(Deserialize, Eq, Packable, Serialize)]
pub struct Config {
    /// `CRISPAztecProgram` on L1: the sender of L1 -> L2 messages and the recipient of the ROOT message.
    pub l1_program: EthAddress,
    /// The Interfold whose E3s this contract serves: the high 160 bits of every full `e3Id`.
    pub interfold: EthAddress,
    /// EIP-712 domain separator of the ballot signature (verifyingContract = the L1 program).
    pub ballot_domain: [Field; 2],
    /// EIP-712 domain separator of the availability attestation.
    pub availability_domain: [Field; 2],
    /// secp256k1 public key (x, y) of the availability signer.
    pub signer_x: [Field; 2],
    pub signer_y: [Field; 2],
    /// Poseidon2 hashes of the verification keys of the three base circuits a ballot is proven with
    /// (`user_data_encryption_ct0`, `user_data_encryption_ct1`, crisp), for the BFV preset of this deployment.
    pub ct0_vk_hash: Field,
    pub ct1_vk_hash: Field,
    pub crisp_vk_hash: Field,
    /// ZKPassport domain hash, circuit-manifest version, proof validity period and registry.
    pub zkpassport_domain: Field,
    pub zkpassport_version: Field,
    pub zkpassport_validity_period: u64,
    pub zkpassport_registry: AztecAddress,
}

/// Round parameters delivered by the ROUND message.
#[derive(Deserialize, Eq, Packable, Serialize)]
pub struct RoundConfig {
    pub num_options: Field,
    pub credits: Field,
    pub input_start: u64,
    pub input_end: u64,
    pub input_limit: u32,
    pub scope_hash: Field,
    pub min_age: u8,
    pub allow_mock_documents: bool,
    /// `NATIONALITY_*`. With a rule the proof must show it against `nationality_commitment`, which is non-zero;
    /// without one the commitment is 0.
    pub nationality_mode: u8,
    pub nationality_commitment: Field,
}

/// What the contract remembers of an input, to check the parent of a later one.
#[derive(Deserialize, Eq, Packable, Serialize)]
pub struct InputEntry {
    pub slot: Field,
    pub commitment: Field,
}
