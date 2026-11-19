// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

//! Token-holder discovery from the logs of the chain's own RPC.
//!
//! Etherscan does not index every chain, and the voting token of a Gnosis instance lives on a chain
//! it does not serve. Voting power of an `ERC20Votes` token belongs to delegates, and a delegate
//! with power at any timepoint emitted `DelegateVotesChanged`, so the delegates named by those logs
//! are the candidates: a holder who never delegated has no votes and cannot vote.

use super::etherscan::{verify_voting_power, ERC20Votes, PotentialVoter};
use crate::server::models::TokenHolder;
use alloy::{
    primitives::{Address, U256},
    providers::{DynProvider, Provider},
    rpc::types::Filter,
    sol_types::SolEvent,
};
use eyre::Result;
use std::collections::BTreeSet;

/// The delegates the token names in `DelegateVotesChanged` logs from `from_block` to the head, read
/// `chunk_size` blocks at a time, in address order.
async fn delegates(
    provider: &DynProvider,
    token: Address,
    from_block: u64,
    chunk_size: u64,
) -> Result<Vec<PotentialVoter>> {
    let latest = provider.get_block_number().await?;
    let mut delegates = BTreeSet::new();
    let mut from = from_block;
    while from <= latest {
        let to = latest.min(from.saturating_add(chunk_size.max(1) - 1));
        let filter = Filter::new()
            .address(token)
            .event_signature(ERC20Votes::DelegateVotesChanged::SIGNATURE_HASH)
            .from_block(from)
            .to_block(to);
        for log in provider.get_logs(&filter).await? {
            // `DelegateVotesChanged(delegate, ..)`: the delegate is topic 1.
            if let Some(delegate) = log.topics().get(1).copied().map(Address::from_word) {
                if !delegate.is_zero() {
                    delegates.insert(delegate);
                }
            }
        }
        from = to.saturating_add(1);
        if to == u64::MAX {
            break;
        }
    }
    Ok(delegates
        .into_iter()
        .map(|address| PotentialVoter {
            address,
            token_balance: U256::ZERO,
            has_delegation: true,
        })
        .collect())
}

/// The delegates of `token` whose votes at `timepoint` reach `threshold`, with their votes over
/// `divisor` as the balance: the mask targets of a round of the Gnosis voting contract. The logs
/// are read from `from_block`, the first block that can hold one.
pub async fn get_token_holders_with_voting_power(
    provider: DynProvider,
    token: Address,
    from_block: u64,
    chunk_size: u64,
    timepoint: u64,
    threshold: U256,
    divisor: U256,
) -> Result<Vec<TokenHolder>> {
    let candidates = delegates(&provider, token, from_block, chunk_size).await?;
    log::info!("Found {} delegates of {token}", candidates.len());
    verify_voting_power(
        &ERC20Votes::new(token, provider),
        &candidates,
        timepoint,
        threshold,
        divisor,
    )
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy::{
        primitives::{Bytes, B256},
        providers::ProviderBuilder,
        transports::mock::Asserter,
    };
    use serde_json::json;

    const TOKEN: Address = Address::repeat_byte(0x77);

    fn delegate_log(delegate: Address) -> serde_json::Value {
        json!({
            "address": TOKEN,
            "topics": [
                ERC20Votes::DelegateVotesChanged::SIGNATURE_HASH,
                delegate.into_word(),
            ],
            "data": format!("0x{}", "00".repeat(64)),
            "blockNumber": "0x5",
            "blockHash": B256::repeat_byte(1),
            "transactionHash": B256::repeat_byte(2),
            "transactionIndex": "0x0",
            "logIndex": "0x0",
            "removed": false,
        })
    }

    fn mocked(responses: &Asserter) -> DynProvider {
        ProviderBuilder::default()
            .connect_mocked_client(responses.clone())
            .erased()
    }

    fn votes(amount: u64) -> serde_json::Value {
        json!(Bytes::from(U256::from(amount).to_be_bytes::<32>()))
    }

    #[tokio::test]
    async fn the_candidates_are_the_distinct_delegates_across_every_chunk() {
        let (alice, bob) = (Address::repeat_byte(0xa), Address::repeat_byte(0xb));
        let responses = Asserter::new();
        // The head is block 5: chunks of two blocks cover 1-2, 3-4 and 5.
        responses.push_success(&json!("0x5"));
        responses.push_success(&json!([delegate_log(bob), delegate_log(alice)]));
        responses.push_success(&json!([delegate_log(bob)]));
        // The zero address names a delegation that ended.
        responses.push_success(&json!([delegate_log(Address::ZERO)]));

        let found = delegates(&mocked(&responses), TOKEN, 1, 2).await.unwrap();

        assert_eq!(
            found.iter().map(|voter| voter.address).collect::<Vec<_>>(),
            [alice, bob]
        );
        assert!(responses.read_q().is_empty());
    }

    #[tokio::test(start_paused = true)]
    async fn holders_are_the_delegates_with_enough_votes_at_the_timepoint() {
        let (alice, bob) = (Address::repeat_byte(0xa), Address::repeat_byte(0xb));
        let responses = Asserter::new();
        responses.push_success(&json!("0x5"));
        responses.push_success(&json!([delegate_log(bob), delegate_log(alice)]));
        // `getPastVotes` of alice, then bob, who is below the threshold of 10.
        responses.push_success(&votes(30));
        responses.push_success(&votes(9));

        let holders = get_token_holders_with_voting_power(
            mocked(&responses),
            TOKEN,
            1,
            100,
            42,
            U256::from(10),
            U256::from(10),
        )
        .await
        .unwrap();

        assert_eq!(holders.len(), 1);
        assert_eq!(holders[0].address, alice.to_string());
        assert_eq!(holders[0].balance, "3");
    }
}
