use aztec::protocol::{address::EthAddress, traits::{Deserialize, Packable, Serialize}};

/// Deployment-wide settings, fixed at construction. Bytes32 values are stored as two 128-bit halves.
#[derive(Deserialize, Eq, Packable, Serialize)]
pub struct Config {
    /// `CRISPAztecVotesProgram` on L1: the sender of L1 -> L2 messages and the recipient of the ROOT message.
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
    /// Poseidon2 hashes of the verification keys of the three base circuits a ballot is proven with.
    pub ct0_vk_hash: Field,
    pub ct1_vk_hash: Field,
    pub crisp_vk_hash: Field,
}

/// Round parameters delivered by the ROUND message. Weights are not part of it: each slot's weight arrives with its
/// ENROLL message.
#[derive(Deserialize, Eq, Packable, Serialize)]
pub struct RoundConfig {
    pub num_options: Field,
    pub input_start: u64,
    pub input_end: u64,
    pub input_limit: u32,
}

/// Staging keys one slot may bind per round: a wallet that lost its secret can bind again, a few times.
pub global MAX_STAGING_BINDS: u8 = 3;

/// Leaf counts of a round's census tree, staging tree and input tree.
#[derive(Deserialize, Eq, Packable, Serialize)]
pub struct Counts {
    pub census: u32,
    pub staging: u32,
    pub inputs: u32,
}

/// What a slot has done in a round: enrolled by its ENROLL message, and how many staging keys it bound.
#[derive(Deserialize, Eq, Packable, Serialize)]
pub struct SlotState {
    pub enrolled: bool,
    pub binds: u8,
}
