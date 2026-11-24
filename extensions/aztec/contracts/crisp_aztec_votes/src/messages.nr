//! Contents of the L1 -> L2 messages of the votes program (`CRISPAztecVotesProgram`). KEY and ROOT are the shared
//! `key_content` / `root_content`.

use aztec::protocol::hash::sha256_to_field;
use crisp_aztec_lib::{constants::{MESSAGE_ENROLL, MESSAGE_ROUND}, hashing::{put, word}};

/// ROUND: `sha256_to_field(abi.encode(1, roundId, numOptions, inputStart, inputEnd, inputLimit))`.
pub fn round_content(
    round_id: Field,
    num_options: Field,
    input_start: u64,
    input_end: u64,
    input_limit: u32,
) -> Field {
    let words = [MESSAGE_ROUND, round_id, num_options, input_start as Field, input_end as Field, input_limit as Field];
    let mut encoded = [0; 192];
    for i in 0..6 {
        encoded = put(encoded, i * 32, word(words[i]));
    }
    sha256_to_field(encoded)
}

/// ENROLL: `sha256_to_field(abi.encode(4, roundId, uint256(uint160(slot)), weight))`.
pub fn enroll_content(round_id: Field, slot: Field, weight: Field) -> Field {
    let mut encoded = [0; 128];
    encoded = put(encoded, 0, word(MESSAGE_ENROLL));
    encoded = put(encoded, 32, word(round_id));
    encoded = put(encoded, 64, word(slot));
    encoded = put(encoded, 96, word(weight));
    sha256_to_field(encoded)
}
