// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

//! Reads the inputs of CRISP rounds from the `CrispGnosisVoting` contract through a Gnosis-chain
//! RPC.
//!
//! `CrispGnosisVoting` emits the same `InputCommitted` event as `CRISPProgram`, with the Interfold
//! E3 id as its first indexed topic, so one `eth_getLogs` filter on that topic lists the inputs of
//! one round in the order the contract accepted them.

use alloy::{
    eips::BlockNumberOrTag,
    primitives::{Address, B256, U256},
    providers::{DynProvider, Provider},
    rpc::types::{Filter, Log},
    sol,
    sol_types::SolEvent,
};
use async_trait::async_trait;
use crisp_remote_input::{CensusRootPage, InputPage, RemoteInput, RemoteInputSource};
use eyre::{ensure, eyre, Result};

sol! {
    /// Emitted by `CrispGnosisVoting` for every input it accepts. The layout of
    /// `CRISPProgram.InputCommitted`.
    event InputCommitted(
        uint256 indexed e3Id,
        bytes32 indexed inputId,
        address indexed slotAddress,
        bytes32 encryptedVoteCommitment,
        bytes32 encryptedVoteHash,
        uint40 parentIndexPlusOne,
        uint40 index
    );

    struct Round {
        uint256 inputStart;
        uint256 inputEnd;
        uint256 inputLimit;
        uint256 numOptions;
        uint256 snapshot;
        uint256 divisor;
        uint256 plaintextModulus;
        bytes32 committeeKey;
        bytes32 proposalHash;
        address requester;
        bool closed;
        uint256 numInputs;
        string metadataCid;
    }

    #[sol(rpc)]
    interface ICrispGnosisVoting {
        function roundOf(uint256 roundId) external view returns (Round memory);
        function minVotingPower() external view returns (uint256);
    }
}

/// Width of the round id of `CrispGnosisVoting`: the low 96 bits of the Interfold E3 id.
const ROUND_ID_BITS: usize = 96;

/// The contract's round id of an Interfold E3 id.
pub fn round_id_of(e3_id: U256) -> U256 {
    e3_id & ((U256::from(1) << ROUND_ID_BITS) - U256::from(1))
}

/// Where an input sits in the chain's order, which is also how a later query resumes after it. The
/// cursor travels as `block:log_index`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
struct Position {
    block: u64,
    log_index: u64,
}

impl Position {
    /// The position after every log of `block`.
    fn end_of(block: u64) -> Self {
        Self {
            block,
            log_index: u64::MAX,
        }
    }

    fn render(&self) -> String {
        format!("{}:{}", self.block, self.log_index)
    }

    fn parse(cursor: &str) -> Result<Self> {
        let (block, log_index) = cursor
            .split_once(':')
            .ok_or_else(|| eyre!("the cursor '{cursor}' is not block:log_index"))?;
        Ok(Self {
            block: block.parse()?,
            log_index: log_index.parse()?,
        })
    }

    /// The first block a query that resumes after this position has to read.
    fn resume_block(&self) -> u64 {
        if self.log_index == u64::MAX {
            self.block.saturating_add(1)
        } else {
            self.block
        }
    }

    fn of_log(log: &Log) -> Result<Self> {
        Ok(Self {
            block: log
                .block_number
                .ok_or_else(|| eyre!("a log has no block number"))?,
            log_index: log
                .log_index
                .ok_or_else(|| eyre!("a log has no log index"))?,
        })
    }
}

/// What the server reads of a round of the voting contract.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GnosisRound {
    /// The timepoint voting power is read at, in the token's clock.
    pub snapshot: u64,
    /// Raw token voting power per ballot unit. Never zero.
    pub divisor: U256,
}

/// The inputs of the `CrispGnosisVoting` contract at `voting`.
#[derive(Clone)]
pub struct GnosisInputSource {
    provider: DynProvider,
    voting: Address,
    /// The first block that can hold a log of the contract. Rounds start from it.
    start_block: u64,
    /// The widest block range of one `eth_getLogs` request.
    chunk_size: u64,
}

impl GnosisInputSource {
    pub fn new(provider: DynProvider, voting: Address, start_block: u64, chunk_size: u64) -> Self {
        Self {
            provider,
            voting,
            start_block,
            chunk_size: chunk_size.max(1),
        }
    }

    /// The round of `e3_id` as the contract holds it, or `None` while it holds none. The ROUND
    /// message reaches the contract some time after the E3 is requested.
    pub async fn round(&self, e3_id: U256) -> Result<Option<GnosisRound>> {
        let round = ICrispGnosisVoting::new(self.voting, self.provider.clone())
            .roundOf(round_id_of(e3_id))
            .call()
            .await?;
        if round.inputEnd.is_zero() {
            return Ok(None);
        }
        Ok(Some(GnosisRound {
            snapshot: u64::try_from(round.snapshot)
                .map_err(|_| eyre!("the snapshot {} does not fit in u64", round.snapshot))?,
            divisor: round.divisor,
        }))
    }

    /// The contract's `minVotingPower`: raw voting power below `max(minVotingPower, divisor)`
    /// carries no weight.
    pub async fn min_voting_power(&self) -> Result<U256> {
        Ok(ICrispGnosisVoting::new(self.voting, self.provider.clone())
            .minVotingPower()
            .call()
            .await?)
    }

    fn decode(log: &Log, e3_id: U256) -> Result<(Position, RemoteInput)> {
        let position = Position::of_log(log)?;
        let committed = log.log_decode::<InputCommitted>()?.inner.data;
        ensure!(
            committed.e3Id == e3_id,
            "the log filter returned an input of round {}",
            committed.e3Id
        );
        Ok((
            position,
            RemoteInput {
                e3_id,
                index: committed.index.to::<u64>(),
                slot: committed.slotAddress,
                commitment: committed.encryptedVoteCommitment,
                ciphertext_hash: committed.encryptedVoteHash,
                parent_index_plus_one: committed.parentIndexPlusOne.to::<u64>(),
                cursor: position.render(),
            },
        ))
    }
}

#[async_trait]
impl RemoteInputSource for GnosisInputSource {
    async fn fetch_inputs(&self, e3_id: U256, after: Option<&str>) -> Result<InputPage> {
        let after = after.map(Position::parse).transpose()?;
        let from = after.map_or(self.start_block, |after| after.resume_block());
        let latest = self.provider.get_block_number().await?;
        if from > latest {
            return Ok(InputPage::default());
        }
        let to = latest.min(from.saturating_add(self.chunk_size - 1));

        let filter = Filter::new()
            .address(self.voting)
            .event_signature(InputCommitted::SIGNATURE_HASH)
            .topic1(B256::from(e3_id.to_be_bytes::<32>()))
            .from_block(from)
            .to_block(to);
        let mut inputs = self
            .provider
            .get_logs(&filter)
            .await?
            .iter()
            .map(|log| Self::decode(log, e3_id))
            .collect::<Result<Vec<_>>>()?;
        inputs.sort_by_key(|(position, _)| *position);

        Ok(InputPage {
            inputs: inputs
                .into_iter()
                .filter(|(position, _)| after.is_none_or(|after| *position > after))
                .map(|(_, input)| input)
                .collect(),
            // Every block of the range was read, so the next query starts after it.
            scanned_to: Some(Position::end_of(to).render()),
            more: to < latest,
        })
    }

    /// A Gnosis round has no staging pass and so no census roots.
    async fn census_roots(
        &self,
        _e3_id: U256,
        _after: Option<&str>,
        _proven_only: bool,
    ) -> Result<CensusRootPage> {
        Ok(CensusRootPage::default())
    }

    async fn latest_timestamp(&self) -> Result<u64> {
        Ok(self
            .provider
            .get_block_by_number(BlockNumberOrTag::Latest)
            .await?
            .ok_or_else(|| eyre!("the voting chain returned no latest block"))?
            .header
            .timestamp)
    }
}

#[cfg(test)]
mod tests;
