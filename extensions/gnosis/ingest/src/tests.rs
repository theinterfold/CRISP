// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

use super::*;
use alloy::{
    primitives::{address, aliases::U40, Bytes},
    providers::ProviderBuilder,
    sol_types::SolValue,
    transports::mock::Asserter,
};
use serde_json::json;

const VOTING: Address = address!("0x00000000000000000000000000000000000000c1");
const SLOT: Address = address!("0x00000000000000000000000000000000000000aa");

/// The Interfold E3 id of round `round`, far above the BN254 modulus.
fn e3(round: u64) -> U256 {
    (U256::from(0xdfa5_9d66_c173_a006u64) << 160) | U256::from(round)
}

/// A log of `CrispGnosisVoting` as a node returns it.
fn log(e3_id: U256, index: u64, block: u64, log_index: u64) -> Log {
    let event = InputCommitted {
        e3Id: e3_id,
        inputId: B256::repeat_byte(0x01),
        slotAddress: SLOT,
        encryptedVoteCommitment: B256::repeat_byte(0x11),
        encryptedVoteHash: B256::repeat_byte(0x22),
        parentIndexPlusOne: U40::from(index),
        index: U40::from(index),
    };
    Log {
        inner: alloy::primitives::Log {
            address: VOTING,
            data: event.encode_log_data(),
        },
        block_number: Some(block),
        log_index: Some(log_index),
        ..Default::default()
    }
}

/// A source whose node answers `answers` in order, and the node's asserter.
fn source(answers: Vec<serde_json::Value>, chunk_size: u64) -> GnosisInputSource {
    let asserter = Asserter::new();
    for answer in answers {
        asserter.push_success(&answer);
    }
    let provider = ProviderBuilder::new()
        .connect_mocked_client(asserter)
        .erased();
    GnosisInputSource::new(provider, VOTING, 10, chunk_size)
}

#[test]
fn a_round_id_is_the_low_96_bits_of_the_e3_id() {
    assert_eq!(round_id_of(e3(7)), U256::from(7));
    assert_eq!(round_id_of(U256::from(5)), U256::from(5));
}

#[test]
fn a_cursor_names_a_block_and_a_log_and_resumes_after_it() {
    let input = Position {
        block: 12,
        log_index: 3,
    };
    assert_eq!(Position::parse(&input.render()).unwrap(), input);
    assert_eq!(input.resume_block(), 12);
    // After a whole block, the next one starts the next query.
    assert_eq!(Position::end_of(12).resume_block(), 13);
    assert!(input < Position::end_of(12));
    assert!(Position::end_of(12) < Position { block: 13, log_index: 0 });
    assert!(Position::parse("12").is_err());
    assert!(Position::parse("12:x").is_err());
}

#[test]
fn an_input_log_decodes_to_the_fields_the_round_needs() {
    let (position, input) = GnosisInputSource::decode(&log(e3(7), 4, 21, 2), e3(7)).unwrap();

    assert_eq!(
        position,
        Position {
            block: 21,
            log_index: 2
        }
    );
    assert_eq!(
        input,
        RemoteInput {
            e3_id: e3(7),
            index: 4,
            slot: SLOT,
            commitment: B256::repeat_byte(0x11),
            ciphertext_hash: B256::repeat_byte(0x22),
            parent_index_plus_one: 4,
            cursor: "21:2".to_owned(),
        }
    );
}

#[test]
fn a_log_of_another_round_or_event_is_refused() {
    assert!(GnosisInputSource::decode(&log(e3(8), 0, 21, 0), e3(7)).is_err());

    let mut other = log(e3(7), 0, 21, 0);
    other.inner.data = alloy::primitives::LogData::new_unchecked(
        vec![B256::repeat_byte(0xee)],
        Bytes::new(),
    );
    assert!(GnosisInputSource::decode(&other, e3(7)).is_err());
}

#[tokio::test]
async fn the_inputs_of_a_round_come_in_chain_order_and_the_page_ends_at_the_head() {
    // Logs are listed out of order on purpose.
    let source = source(
        vec![
            json!("0x20"),
            json!([
                log(e3(7), 1, 21, 5),
                log(e3(7), 0, 21, 1),
                log(e3(7), 2, 30, 0)
            ]),
        ],
        1_000,
    );

    let page = source.fetch_inputs(e3(7), None).await.unwrap();

    assert_eq!(
        page.inputs.iter().map(|input| input.index).collect::<Vec<_>>(),
        [0, 1, 2]
    );
    assert_eq!(page.inputs[2].cursor, "30:0");
    // The head is block 0x20 = 32 and every block up to it was read.
    assert_eq!(page.scanned_to.as_deref(), Some("32:18446744073709551615"));
    assert!(!page.more);
}

#[tokio::test]
async fn a_long_history_is_read_in_chunks() {
    // Blocks 10..=14 of a head at 100.
    let source = source(vec![json!("0x64"), json!([])], 5);

    let page = source.fetch_inputs(e3(7), None).await.unwrap();

    assert!(page.inputs.is_empty());
    assert_eq!(page.scanned_to.as_deref(), Some("14:18446744073709551615"));
    assert!(page.more);
}

#[tokio::test]
async fn a_query_resumes_after_its_cursor_and_drops_what_it_already_returned() {
    // The input at 21:1 was stored; the block holds it again with the next one.
    let source = source(
        vec![json!("0x20"), json!([log(e3(7), 0, 21, 1), log(e3(7), 1, 21, 5)])],
        1_000,
    );

    let page = source.fetch_inputs(e3(7), Some("21:1")).await.unwrap();

    assert_eq!(
        page.inputs.iter().map(|input| input.index).collect::<Vec<_>>(),
        [1]
    );
}

#[tokio::test]
async fn nothing_is_read_past_the_head() {
    let source = source(vec![json!("0x20")], 1_000);

    let page = source
        .fetch_inputs(e3(7), Some("32:18446744073709551615"))
        .await
        .unwrap();

    assert_eq!(page, InputPage::default());
}

/// The answer of `roundOf` for a round with `input_end`, `snapshot` and `divisor`.
fn round_of(input_end: u64, snapshot: u64, divisor: u64) -> serde_json::Value {
    let round = Round {
        inputStart: U256::ZERO,
        inputEnd: U256::from(input_end),
        inputLimit: U256::ZERO,
        numOptions: U256::from(3),
        snapshot: U256::from(snapshot),
        divisor: U256::from(divisor),
        plaintextModulus: U256::ZERO,
        committeeKey: B256::ZERO,
        proposalHash: B256::ZERO,
        requester: Address::ZERO,
        closed: false,
        numInputs: U256::ZERO,
        metadataCid: "cid".to_owned(),
    };
    json!(Bytes::from(round.abi_encode()))
}

#[tokio::test]
async fn a_round_the_contract_does_not_hold_yet_reads_as_none() {
    assert_eq!(
        source(vec![round_of(0, 0, 0)], 1).round(e3(7)).await.unwrap(),
        None
    );
    assert_eq!(
        source(vec![round_of(500, 99, 9)], 1)
            .round(e3(7))
            .await
            .unwrap(),
        Some(GnosisRound {
            snapshot: 99,
            divisor: U256::from(9)
        })
    );
}

#[tokio::test]
async fn a_gnosis_round_has_no_census_roots() {
    let page = source(vec![], 1)
        .census_roots(e3(7), None, true)
        .await
        .unwrap();

    assert_eq!(page, CensusRootPage::default());
}
