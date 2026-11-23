//! Content of the ROUND message of the ZKPassport program (`CRISPAztecProgram`).

use aztec::protocol::hash::sha256_to_field;
use crisp_aztec_lib::{constants::MESSAGE_ROUND, hashing::{put, word}};

/// Content of the ROUND message `Interfold.request` sends from L1. Word 2 is the round id (`uint96(e3Id)`).
pub fn round_content(
    round_id: Field,
    num_options: Field,
    credits: Field,
    input_start: u64,
    input_end: u64,
    input_limit: u32,
    scope_hash: Field,
    min_age: u8,
    allow_mock_documents: bool,
    nationality_mode: u8,
    nationality_commitment: Field,
) -> Field {
    let words = [
        MESSAGE_ROUND,
        round_id,
        num_options,
        credits,
        input_start as Field,
        input_end as Field,
        input_limit as Field,
        scope_hash,
        min_age as Field,
        allow_mock_documents as Field,
        nationality_mode as Field,
        nationality_commitment,
    ];
    let mut encoded = [0; 384];
    for i in 0..12 {
        encoded = put(encoded, i * 32, word(words[i]));
    }
    sha256_to_field(encoded)
}

