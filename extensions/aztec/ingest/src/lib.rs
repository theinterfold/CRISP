// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

//! Reads the inputs of CRISP rounds from the `CrispAztec` contract through an Aztec node.
//!
//! The node exposes public logs only by tag (`node_getPublicLogsByTags`), and indexes a log by its
//! first field. `CrispAztec` emits `INPUT_COMMITTED` with the field `1` first, so one tag query
//! lists every input of the contract in the order the L2 accepted them.

mod log;

pub use log::{
    e3_id_of, round_id_of, InputCommitted, MemberRegistered, INPUT_COMMITTED_TAG,
    MEMBER_REGISTERED_TAG,
};

use alloy::primitives::{Address, B256, U256};
use async_trait::async_trait;
use crisp_remote_input::{CensusRootPage, InputPage, RemoteInput, RemoteInputSource};
use eyre::{bail, ensure, eyre, Context, Result};
use serde_json::{json, Value};
use std::time::Duration;

/// A node answer is a small JSON document. A node that does not answer within this bound is
/// treated as down and the caller retries on its next pass.
const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);

/// The node returns at most this many logs per tag and query (`MAX_LOGS_PER_TAG`). A full page
/// means more logs may follow.
const PAGE_SIZE: usize = 20;

/// A JSON-RPC client for the `node_` namespace of an Aztec node.
#[derive(Clone)]
pub struct AztecNode {
    http: reqwest::Client,
    url: String,
}

impl AztecNode {
    pub fn new(url: impl Into<String>) -> Result<Self> {
        Ok(Self {
            http: reqwest::Client::builder()
                .timeout(REQUEST_TIMEOUT)
                .build()
                .context("Failed to build the Aztec node client")?,
            url: url.into(),
        })
    }

    async fn call(&self, method: &str, params: Value) -> Result<Value> {
        let response: Value = self
            .http
            .post(&self.url)
            .json(&json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params }))
            .send()
            .await
            .with_context(|| format!("Aztec node request {method} failed"))?
            .error_for_status()
            .with_context(|| format!("Aztec node refused {method}"))?
            .json()
            .await
            .with_context(|| format!("Aztec node answered {method} with invalid JSON"))?;
        if let Some(error) = response.get("error") {
            bail!("Aztec node rejected {method}: {error}");
        }
        response
            .get("result")
            .cloned()
            .ok_or_else(|| eyre!("Aztec node answered {method} without a result"))
    }
}

/// Where a log sits in the node's order, which is also how a later query resumes after it. The
/// cursor travels as `block-tx-log`, the form of the node's own log cursor.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct Position {
    block: u64,
    tx: u64,
    log: u64,
}

impl Position {
    fn parse(cursor: &str) -> Result<Self> {
        let mut parts = cursor.split('-').map(str::parse::<u64>);
        match (parts.next(), parts.next(), parts.next(), parts.next()) {
            (Some(Ok(block)), Some(Ok(tx)), Some(Ok(log)), None) => Ok(Self { block, tx, log }),
            _ => bail!("'{cursor}' is not a block-tx-log cursor"),
        }
    }

    fn render(self) -> String {
        format!("{}-{}-{}", self.block, self.tx, self.log)
    }

    fn json(self) -> Value {
        json!({
            "blockNumber": self.block,
            "txIndexWithinBlock": self.tx,
            "logIndexWithinTx": self.log,
        })
    }

    fn of_log(log: &Value) -> Result<Self> {
        let number = |name: &str| {
            log.get(name)
                .and_then(Value::as_u64)
                .ok_or_else(|| eyre!("a node log has no numeric {name}"))
        };
        Ok(Self {
            block: number("blockNumber")?,
            tx: number("txIndexWithinBlock")?,
            log: number("logIndexWithinTx")?,
        })
    }
}

/// The inputs of the `CrispAztec` contract at `contract`.
#[derive(Clone)]
pub struct AztecInputSource {
    node: AztecNode,
    /// The contract address as the node takes it, a 32-byte hex string.
    contract: String,
    /// The Interfold the program is bound to. Its address is the top of every E3 id of the
    /// program, which the contract's round ids leave out.
    interfold: Address,
    /// The first L2 block that can hold a log of the contract. Rounds start from it.
    start_block: Option<u64>,
}

impl AztecInputSource {
    pub fn new(
        node: AztecNode,
        contract: B256,
        interfold: Address,
        start_block: Option<u64>,
    ) -> Self {
        Self {
            node,
            contract: contract.to_string(),
            interfold,
            start_block,
        }
    }
}

impl AztecInputSource {
    /// The number of the newest block of a proven epoch (`node_getChainTips`, `proven.block`).
    async fn proven_block(&self) -> Result<u64> {
        let tips = self.node.call("node_getChainTips", json!([])).await?;
        tips["proven"]["block"]["number"]
            .as_u64()
            .ok_or_else(|| eyre!("node_getChainTips answered without a proven block number"))
    }
}

impl AztecInputSource {
    /// The logs under `tag` after `after` (from the start block when `None`) up to `to_block`
    /// exclusive (the node's newest block when `None`), as each one's position and fields.
    async fn logs(
        &self,
        tag: u64,
        after: Option<&str>,
        to_block: Option<u64>,
    ) -> Result<Vec<(Position, Vec<U256>)>> {
        let tag = format!("{:#066x}", U256::from(tag));
        let mut query = json!({
            "contractAddress": self.contract,
            "tags": [match after {
                Some(cursor) => json!({ "tag": tag, "afterLog": Position::parse(cursor)?.json() }),
                None => json!(tag),
            }],
        });
        if let Some(to_block) = to_block {
            query["toBlock"] = json!(to_block);
        }
        if after.is_none() {
            if let Some(start) = self.start_block {
                query["fromBlock"] = json!(start);
            }
        }

        let result = self
            .node
            .call("node_getPublicLogsByTags", json!([query]))
            .await?;
        // One list per queried tag.
        let logs = result
            .get(0)
            .and_then(Value::as_array)
            .ok_or_else(|| eyre!("node_getPublicLogsByTags answered without a log list"))?;

        logs.iter()
            .map(|log| {
                let position = Position::of_log(log)?;
                ensure!(
                    after.is_none_or(
                        |cursor| Position::parse(cursor).is_ok_and(|after| position > after)
                    ),
                    "the node returned a log at or before the cursor"
                );
                let data = log
                    .get("logData")
                    .and_then(Value::as_array)
                    .ok_or_else(|| eyre!("a node log has no logData"))?;
                let fields = data
                    .iter()
                    .map(log::parse_field)
                    .collect::<Result<Vec<_>>>()?;
                Ok((position, fields))
            })
            .collect()
    }
}

#[async_trait]
impl RemoteInputSource for AztecInputSource {
    async fn fetch_inputs(&self, e3_id: U256, after: Option<&str>) -> Result<InputPage> {
        // Only blocks of a proven epoch are read. The node drops the unproven blocks of an epoch
        // that is never proven and reuses their numbers, so a cursor that passed one of them would
        // skip the logs that replace it, and the dropped inputs would stay in the round. The root
        // that reaches L1 follows the same epoch proof, so this adds no wait. `toBlock` is
        // exclusive.
        let proven = self.proven_block().await?;
        if proven == 0 {
            // Nothing is proven yet, so nothing can be read.
            return Ok(InputPage::default());
        }
        let logs = self
            .logs(INPUT_COMMITTED_TAG, after, Some(proven + 1))
            .await?;

        let mut inputs = Vec::new();
        let mut scanned_to = None;
        for (position, fields) in &logs {
            scanned_to = Some(position.render());
            let committed = InputCommitted::decode(fields)?;
            // The log names the round by its low 96 bits; everything past this point speaks the
            // Interfold E3 id.
            if e3_id_of(self.interfold, committed.round_id) != e3_id {
                continue;
            }
            inputs.push(RemoteInput {
                e3_id,
                index: committed.index,
                slot: committed.slot,
                commitment: committed.commitment,
                ciphertext_hash: committed.vote_hash,
                parent_index_plus_one: committed.parent_index_plus_one,
                cursor: position.render(),
            });
        }
        Ok(InputPage {
            inputs,
            scanned_to,
            more: logs.len() >= PAGE_SIZE,
        })
    }

    async fn census_roots(
        &self,
        e3_id: U256,
        after: Option<&str>,
        proven_only: bool,
    ) -> Result<CensusRootPage> {
        // As `fetch_inputs`: a position past an unproven block could skip the logs that replace it.
        let to_block = if proven_only {
            let proven = self.proven_block().await?;
            if proven == 0 {
                return Ok(CensusRootPage::default());
            }
            Some(proven + 1)
        } else {
            None
        };
        let logs = self.logs(MEMBER_REGISTERED_TAG, after, to_block).await?;

        let mut roots = Vec::new();
        for (_, fields) in &logs {
            let member = MemberRegistered::decode(fields)?;
            if e3_id_of(self.interfold, member.round_id) == e3_id {
                roots.push(member.census_root);
            }
        }
        Ok(CensusRootPage {
            roots,
            scanned_to: logs.last().map(|(position, _)| position.render()),
            more: logs.len() >= PAGE_SIZE,
        })
    }

    async fn latest_timestamp(&self) -> Result<u64> {
        let block = self
            .node
            .call("node_getBlockData", json!(["latest"]))
            .await?;
        let timestamp = &block["header"]["globalVariables"]["timestamp"];
        // The node writes a u64 as a decimal string.
        timestamp
            .as_str()
            .and_then(|text| text.parse().ok())
            .or_else(|| timestamp.as_u64())
            .ok_or_else(|| eyre!("the latest Aztec block has no timestamp"))
    }
}

#[cfg(test)]
mod tests;
