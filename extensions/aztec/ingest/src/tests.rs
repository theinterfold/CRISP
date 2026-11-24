// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

use super::*;
use alloy::primitives::{address, keccak256};
use std::sync::{Arc, Mutex};
use tokio::{
    io::{AsyncReadExt, AsyncWriteExt},
    net::TcpListener,
};

const CONTRACT: B256 = B256::repeat_byte(0x05);
/// The Interfold of the worked example of `extensions/aztec/l1/tests/fixtures/message-vectors.json`.
const INTERFOLD: Address = address!("0xdFa59d66c173A00643eBE80e172Af5a8Cf244b30");

/// The Interfold E3 id of round `round`, far above the BN254 modulus.
fn e3(round: u64) -> U256 {
    e3_id_of(INTERFOLD, U256::from(round))
}

/// A node that answers each request with the next canned body and records what it was asked.
async fn node(answers: Vec<Value>) -> (AztecNode, Arc<Mutex<Vec<Value>>>) {
    let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", listener.local_addr().unwrap());
    let requests = Arc::new(Mutex::new(Vec::new()));
    let seen = Arc::clone(&requests);
    tokio::spawn(async move {
        for answer in answers {
            let (mut stream, _) = listener.accept().await.unwrap();
            let mut received = Vec::new();
            let body_start = loop {
                let mut chunk = [0u8; 4096];
                let read = stream.read(&mut chunk).await.unwrap();
                received.extend_from_slice(&chunk[..read]);
                if let Some(end) = received.windows(4).position(|window| window == b"\r\n\r\n") {
                    break end + 4;
                }
            };
            let headers = String::from_utf8_lossy(&received[..body_start]).to_lowercase();
            let length: usize = headers
                .lines()
                .find_map(|line| line.strip_prefix("content-length:"))
                .and_then(|value| value.trim().parse().ok())
                .unwrap();
            while received.len() < body_start + length {
                let mut chunk = [0u8; 4096];
                let read = stream.read(&mut chunk).await.unwrap();
                received.extend_from_slice(&chunk[..read]);
            }
            seen.lock()
                .unwrap()
                .push(serde_json::from_slice(&received[body_start..body_start + length]).unwrap());

            let body = answer.to_string();
            let response = format!(
                "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{body}",
                body.len()
            );
            stream.write_all(response.as_bytes()).await.unwrap();
        }
    });
    (AztecNode::new(url).unwrap(), requests)
}

fn field(value: U256) -> Value {
    json!(format!("{value:#066x}"))
}

/// A public log as the node returns it.
fn log(e3_id: u64, index: u64, at: (u64, u64, u64)) -> Value {
    let hash = keccak256(index.to_be_bytes());
    let fields = [
        U256::from(INPUT_COMMITTED_TAG),
        U256::from(e3_id),
        U256::from(index),
        U256::from_be_slice(address!("0x00000000000000000000000000000000000000aa").as_slice()),
        U256::from(0x1000 + index),
        U256::from_be_slice(&hash[..16]),
        U256::from_be_slice(&hash[16..]),
        U256::from(index),
    ];
    json!({
        "logData": fields.map(field),
        "blockNumber": at.0,
        "txIndexWithinBlock": at.1,
        "logIndexWithinTx": at.2,
        "blockTimestamp": "1794872445",
    })
}

/// The node's chain tips, with block `number` proven.
fn proven(number: u64) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": 1,
        "result": { "proposed": { "number": number + 3 }, "proven": { "block": { "number": number } } },
    })
}

fn answer(logs: Vec<Value>) -> Value {
    json!({ "jsonrpc": "2.0", "id": 1, "result": [logs] })
}

fn source(node: AztecNode, start_block: Option<u64>) -> AztecInputSource {
    AztecInputSource::new(node, CONTRACT, INTERFOLD, start_block)
}

#[tokio::test]
async fn a_first_fetch_queries_the_input_tag_from_the_start_block() {
    let (node, requests) = node(vec![proven(100), answer(vec![])]).await;

    let page = source(node, Some(5))
        .fetch_inputs(e3(7), None)
        .await
        .unwrap();

    assert_eq!(page, InputPage::default());
    let request = requests.lock().unwrap()[1].clone();
    assert_eq!(request["method"], "node_getPublicLogsByTags");
    assert_eq!(
        request["params"][0],
        json!({
            "contractAddress": CONTRACT.to_string(),
            "tags": [format!("{:#066x}", 1)],
            "fromBlock": 5,
            "toBlock": 101,
        })
    );
}

#[tokio::test]
async fn a_fetch_returns_only_the_requested_round_and_scans_past_the_rest() {
    let (node, _) = node(vec![
        proven(100),
        answer(vec![
            log(7, 0, (10, 0, 0)),
            log(8, 0, (10, 1, 0)),
            log(7, 1, (11, 0, 2)),
            log(8, 1, (11, 1, 0)),
        ]),
    ])
    .await;

    let page = source(node, None).fetch_inputs(e3(7), None).await.unwrap();

    // The log carries the 96-bit round id; the input carries the Interfold E3 id.
    assert!(page.inputs.iter().all(|input| input.e3_id == e3(7)));

    let indexes: Vec<_> = page.inputs.iter().map(|input| input.index).collect();
    assert_eq!(indexes, [0, 1]);
    assert_eq!(page.inputs[1].cursor, "11-0-2");
    // The cursor passes the other round's last log too, so the next fetch does not read it again.
    assert_eq!(page.scanned_to.as_deref(), Some("11-1-0"));
    assert!(!page.more);
    let first = &page.inputs[0];
    assert_eq!(
        first.slot,
        address!("0x00000000000000000000000000000000000000aa")
    );
    assert_eq!(
        first.commitment,
        B256::from(U256::from(0x1000).to_be_bytes::<32>())
    );
    assert_eq!(first.ciphertext_hash, keccak256(0u64.to_be_bytes()));
}

#[tokio::test]
async fn a_resumed_fetch_asks_for_logs_after_its_cursor() {
    let (node, requests) = node(vec![proven(100), answer(vec![log(7, 2, (12, 0, 0))])]).await;

    let page = source(node, Some(5))
        .fetch_inputs(e3(7), Some("11-0-2"))
        .await
        .unwrap();

    assert_eq!(page.inputs[0].index, 2);
    assert_eq!(
        requests.lock().unwrap()[1]["params"][0],
        json!({
            "contractAddress": CONTRACT.to_string(),
            "tags": [{
                "tag": format!("{:#066x}", 1),
                "afterLog": { "blockNumber": 11, "txIndexWithinBlock": 0, "logIndexWithinTx": 2 },
            }],
            "toBlock": 101,
        })
    );
}

/// Blocks past the proven tip can still be dropped, so they are not read, and nothing is asked of
/// the node while nothing is proven.
#[tokio::test]
async fn only_proven_blocks_are_read() {
    let (chain, requests) = node(vec![proven(0)]).await;
    let page = source(chain, None).fetch_inputs(e3(7), None).await.unwrap();
    assert_eq!(page, InputPage::default());
    assert_eq!(requests.lock().unwrap().len(), 1);
    assert_eq!(requests.lock().unwrap()[0]["method"], "node_getChainTips");

    let (chain, requests) = node(vec![proven(42), answer(vec![])]).await;
    source(chain, None).fetch_inputs(e3(7), None).await.unwrap();
    assert_eq!(requests.lock().unwrap()[1]["params"][0]["toBlock"], 43);
}

#[tokio::test]
async fn a_full_page_says_more_may_follow() {
    let logs = (0..PAGE_SIZE as u64)
        .map(|n| log(7, n, (10 + n, 0, 0)))
        .collect();
    let (node, _) = node(vec![proven(100), answer(logs)]).await;

    let page = source(node, None).fetch_inputs(e3(7), None).await.unwrap();

    assert!(page.more);
    assert_eq!(page.scanned_to.as_deref(), Some("29-0-0"));
}

#[tokio::test]
async fn a_log_that_is_not_after_the_cursor_is_an_error() {
    let (node, _) = node(vec![proven(100), answer(vec![log(7, 0, (11, 0, 2))])]).await;

    let error = source(node, None)
        .fetch_inputs(e3(7), Some("11-0-2"))
        .await
        .unwrap_err();

    assert!(
        error.to_string().contains("at or before the cursor"),
        "{error}"
    );
}

#[tokio::test]
async fn a_malformed_log_under_the_tag_stops_the_fetch() {
    let mut bad = log(7, 0, (10, 0, 0));
    bad["logData"].as_array_mut().unwrap().pop();
    let (node, _) = node(vec![proven(100), answer(vec![bad])]).await;

    assert!(source(node, None).fetch_inputs(e3(7), None).await.is_err());
}

#[tokio::test]
async fn a_node_error_is_reported() {
    let (node, _) = node(vec![
        proven(100),
        json!({ "jsonrpc": "2.0", "id": 1, "error": { "code": -32601, "message": "Method not found" } }),
    ])
    .await;

    let error = source(node, None)
        .fetch_inputs(e3(7), None)
        .await
        .unwrap_err();

    assert!(error.to_string().contains("Method not found"), "{error}");
}

#[tokio::test]
async fn the_clock_is_the_timestamp_of_the_latest_block() {
    let (node, requests) = node(vec![json!({
        "jsonrpc": "2.0",
        "id": 1,
        "result": { "header": { "globalVariables": { "blockNumber": 5, "timestamp": "1794872445" } } },
    })])
    .await;

    let now = source(node, None).latest_timestamp().await.unwrap();

    assert_eq!(now, 1_794_872_445);
    let request = requests.lock().unwrap()[0].clone();
    assert_eq!(request["method"], "node_getBlockData");
    assert_eq!(request["params"], json!(["latest"]));
}

#[test]
fn a_cursor_round_trips_and_orders_by_position() {
    let position = Position::parse("11-0-2").unwrap();
    assert_eq!(position.render(), "11-0-2");
    assert!(position < Position::parse("11-1-0").unwrap());
    assert!(Position::parse("11-0").is_err());
    assert!(Position::parse("11-0-2-1").is_err());
    assert!(Position::parse("a-b-c").is_err());
}

/// A `MEMBER_REGISTERED` public log: `[2, round_id, index, slot, leaf, root]`.
fn member_log(e3_id: u64, index: u64, root: u64, at: (u64, u64, u64)) -> Value {
    let fields = [
        U256::from(MEMBER_REGISTERED_TAG),
        U256::from(e3_id),
        U256::from(index),
        U256::from_be_slice(address!("0x00000000000000000000000000000000000000aa").as_slice()),
        U256::from(0x2000 + index),
        U256::from(root),
    ];
    json!({
        "logData": fields.map(field),
        "blockNumber": at.0,
        "txIndexWithinBlock": at.1,
        "logIndexWithinTx": at.2,
        "blockTimestamp": "1794872445",
    })
}

/// The proven read stops at the proven tip like `fetch_inputs`, and keeps only the requested round.
#[tokio::test]
async fn proven_census_roots_stop_at_the_proven_block_for_one_round() {
    let (node, requests) = node(vec![
        proven(100),
        answer(vec![
            member_log(7, 0, 0x70, (10, 0, 0)),
            member_log(8, 0, 0x80, (10, 1, 0)),
            member_log(7, 1, 0x71, (11, 0, 0)),
        ]),
    ])
    .await;

    let page = source(node, Some(5))
        .census_roots(e3(7), None, true)
        .await
        .unwrap();

    assert_eq!(page.roots, [U256::from(0x70), U256::from(0x71)]);
    assert_eq!(page.scanned_to.as_deref(), Some("11-0-0"));
    assert!(!page.more);
    assert_eq!(
        requests.lock().unwrap()[1]["params"][0],
        json!({
            "contractAddress": CONTRACT.to_string(),
            "tags": [format!("{:#066x}", 2)],
            "fromBlock": 5,
            "toBlock": 101,
        })
    );
}

#[tokio::test]
async fn nothing_is_read_while_nothing_is_proven() {
    let (node, requests) = node(vec![proven(0)]).await;
    let page = source(node, None)
        .census_roots(e3(7), None, true)
        .await
        .unwrap();
    assert_eq!(page, CensusRootPage::default());
    assert_eq!(requests.lock().unwrap().len(), 1);
}

/// A voter who has just registered names a root of a block that is not proven yet, so the tail read
/// goes to the newest block: no chain-tips lookup and no `toBlock`.
#[tokio::test]
async fn the_unproven_tail_is_read_to_the_newest_block() {
    let (node, requests) = node(vec![answer(vec![member_log(7, 2, 0x72, (12, 0, 0))])]).await;

    let page = source(node, Some(5))
        .census_roots(e3(7), Some("11-0-0"), false)
        .await
        .unwrap();

    assert_eq!(page.roots, [U256::from(0x72)]);
    let requests = requests.lock().unwrap();
    assert_eq!(requests.len(), 1);
    assert_eq!(
        requests[0]["params"][0],
        json!({
            "contractAddress": CONTRACT.to_string(),
            "tags": [{
                "tag": format!("{:#066x}", 2),
                "afterLog": { "blockNumber": 11, "txIndexWithinBlock": 0, "logIndexWithinTx": 0 },
            }],
        })
    );
}

#[tokio::test]
async fn census_roots_report_a_full_page() {
    let logs = (0..PAGE_SIZE as u64)
        .map(|n| member_log(7, n, n, (20 + n, 0, 0)))
        .collect();
    let (node, _) = node(vec![answer(logs)]).await;

    let page = source(node, None)
        .census_roots(e3(7), None, false)
        .await
        .unwrap();

    assert!(page.more);
    assert_eq!(page.scanned_to.as_deref(), Some("39-0-0"));
}

#[tokio::test]
async fn a_member_log_of_another_shape_stops_the_census_read() {
    let mut bad = member_log(7, 0, 1, (10, 0, 0));
    bad["logData"].as_array_mut().unwrap().pop();
    let (node, _) = node(vec![answer(vec![bad])]).await;

    assert!(source(node, None)
        .census_roots(e3(7), None, false)
        .await
        .is_err());
}

/// `CrispAztecVotes` staging roots come from `STAGING_KEY_BOUND` logs, which share the layout of
/// `MEMBER_REGISTERED`.
#[tokio::test]
async fn staging_roots_are_read_under_the_staging_key_bound_tag() {
    let bound = |round, root| {
        let mut log = member_log(round, 0, root, (12, 0, 0));
        log["logData"][0] = field(U256::from(STAGING_KEY_BOUND_TAG));
        log
    };
    let (node, requests) = node(vec![answer(vec![bound(7, 0x91), bound(8, 0x92)])]).await;

    let page = source(node, None)
        .with_staging_roots()
        .census_roots(e3(7), None, false)
        .await
        .unwrap();

    assert_eq!(page.roots, [U256::from(0x91)]);
    assert_eq!(
        requests.lock().unwrap()[0]["params"][0]["tags"],
        json!([format!("{:#066x}", STAGING_KEY_BOUND_TAG)])
    );
}
