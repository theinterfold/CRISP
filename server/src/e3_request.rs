// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

//! The parts of an E3 round request that the `/rounds/request` route and the CLI share.
//!
//! Each caller still owns its compute-provider-params encoding (bincode on the server, JSON in
//! the CLI) and the transaction itself.

use alloy::primitives::{Address, Bytes, U256};
use alloy::sol;
use alloy::sol_types::SolValue;
use e3_sdk::evm::contracts::{
    CommitteeSize, Interfold, InterfoldContract, InterfoldRead, InterfoldWrite, ReadWrite,
};
use e3_sdk::evm::nonce::send_with_next_nonce;
use evm_helpers::CRISPContract;
use log::{error, info, warn};
use serde::Serialize;

use crate::config::CONFIG;
use crate::server::rpc;

sol! {
    #[sol(rpc)]
    contract FeeToken {
        function approve(address spender, uint256 amount) external returns (bool);
        function allowance(address owner, address spender) external view returns (uint256);
    }
}

/// The compute provider settings of a round.
#[derive(Debug, Serialize)]
pub struct ComputeProviderParams {
    pub name: String,
    pub parallel: bool,
    pub batch_size: u32,
}

impl ComputeProviderParams {
    pub fn from_config() -> Self {
        Self {
            name: CONFIG.e3_compute_provider_name.clone(),
            parallel: CONFIG.e3_compute_provider_parallel,
            batch_size: CONFIG.e3_compute_provider_batch_size,
        }
    }
}

/// A `CommitteeSize` with its name and the number of operators it requires.
#[derive(Debug, Clone, Copy)]
pub struct Committee {
    pub size: CommitteeSize,
    pub label: &'static str,
    pub members: u32,
}

/// The committee for `E3_COMMITTEE_SIZE` (0 = Minimum, 1 = Micro, 2 = Small).
pub fn committee(e3_committee_size: u8) -> eyre::Result<Committee> {
    let (size, label, members) = match e3_committee_size {
        0 => (CommitteeSize::Minimum, "Minimum", 3),
        1 => (CommitteeSize::Micro, "Micro", 9),
        2 => (CommitteeSize::Small, "Small", 19),
        invalid => eyre::bail!("Invalid committee size: {invalid}"),
    };
    Ok(Committee {
        size,
        label,
        members,
    })
}

/// Enable the E3 program if it is not enabled yet. A failure is logged and the request goes on:
/// `request_e3` then reverts with the real cause.
pub async fn ensure_program_enabled(
    contract: &(impl InterfoldRead + InterfoldWrite),
    program: Address,
) {
    match contract.is_e3_program_enabled(program).await {
        Ok(true) => info!("E3 Program already enabled"),
        Ok(false) => match contract.register_e3_program(program).await {
            Ok(receipt) => info!("E3 Program enabled. TxHash: {:?}", receipt.transaction_hash),
            Err(e) => warn!("Error enabling E3 Program: {e:?}"),
        },
        Err(e) => error!("Error checking E3 Program enabled: {e:?}"),
    }
}

/// Let Interfold pull the fee of the round that `request_e3` is about to send.
///
/// `Interfold.request` takes the fee from the requester, which is the key of `contract`, with
/// `feeToken.transferFrom`. Without an allowance the request reverts with
/// `ERC20InsufficientAllowance`. The fee is quoted for `input_window`, and the same window must
/// go to `request_e3`: the fee never grows as the chain clock moves toward the window's end, so
/// the quote bounds the fee that the request charges. The allowance is raised to exactly the quote,
/// not to the maximum: a request spends it, so it never stays open. An allowance that already
/// covers the quote is left as it is, and no transaction is sent. Returns the quoted fee.
pub async fn approve_e3_fee(
    contract: &InterfoldContract<ReadWrite>,
    committee: Committee,
    input_window: [U256; 2],
    e3_program: Address,
    param_set: u8,
    compute_provider_params: &Bytes,
) -> eyre::Result<U256> {
    let fee = contract
        .get_e3_quote(
            committee.size,
            input_window,
            e3_program,
            param_set,
            compute_provider_params.clone(),
        )
        .await?;
    info!("Fee required: {fee} tokens");

    let owner = contract
        .wallet_address
        .ok_or_else(|| eyre::eyre!("No wallet address configured"))?;
    let spender = contract.contract_address;
    let fee_token = Interfold::new(spender, &contract.provider)
        .feeToken()
        .call()
        .await?;
    let token = FeeToken::new(fee_token, &contract.provider);
    let allowance = token.allowance(owner, spender).call().await?;
    if allowance >= fee {
        info!("Fee token allowance {allowance} covers the fee");
        return Ok(fee);
    }

    info!("Approving {fee} of fee token {fee_token} for Interfold {spender}");
    let receipt = send_with_next_nonce(token.approve(spender, fee), owner)
        .await?
        .get_receipt()
        .await?;
    eyre::ensure!(receipt.status(), "fee token approval reverted");
    info!("Fee token approved. TxHash: {:?}", receipt.transaction_hash);
    Ok(fee)
}

/// The ABI-encoded custom params of a CRISP round.
///
/// `census_mode` is the `CRISPProgram.CensusMode` discriminant: 0 (TOKEN) or 2 (ONCHAIN). For an
/// ONCHAIN round `balance_threshold` is the `minVotingPower` floor in the token's raw units. The
/// round has two options and constant credits of one. The seventh field is the voting-power
/// divisor, which constant credits ignore; `_initRound` decodes exactly seven fields and reverts
/// on a shorter encoding.
pub fn custom_params(token: Address, balance_threshold: U256, census_mode: u64) -> Bytes {
    let num_options = U256::from(2);
    let credit_mode = U256::ZERO;
    let credits = U256::from(1);
    let voting_power_divisor = U256::ZERO;
    Bytes::from(
        (
            token,
            balance_threshold,
            num_options,
            credit_mode,
            credits,
            U256::from(census_mode),
            voting_power_divisor,
        )
            .abi_encode(),
    )
}

/// The `[start, end]` input window of a round requested now.
///
/// A program with an Avail finalization window starts voting after its worst-case key deadline;
/// any other program starts from the chain time. `E3_DURATION` includes the finalization tail in
/// both cases.
pub async fn voting_window(program: &CRISPContract) -> eyre::Result<[U256; 2]> {
    let avail_window = program.availability_finalization_window().await?;
    let now = rpc::latest_timestamp(rpc::provider().await?).await?;
    let base: u64 = if avail_window.is_zero() {
        now
    } else {
        let (timestamp, native) = program.earliest_voting_start_compatible(now).await?;
        if !native {
            warn!("CRISPProgram has no earliestVotingStart(); derived the schedule from Interfold");
        }
        timestamp.try_into()?
    };
    let start = base
        .checked_add(CONFIG.voting_start_buffer_seconds)
        .ok_or_else(|| eyre::eyre!("voting start overflow"))?;
    let end = start
        .checked_add(CONFIG.e3_duration)
        .ok_or_else(|| eyre::eyre!("voting end overflow"))?;
    Ok([U256::from(start), U256::from(end)])
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy::node_bindings::{Anvil, AnvilInstance};
    use alloy::providers::{ext::AnvilApi, Provider, ProviderBuilder};
    use alloy::signers::local::PrivateKeySigner;

    sol! {
        /// `tests/fixtures/mock_fee_interfold.sol`, built with solc 0.8.30 and
        /// `solc --optimize --bin mock_fee_interfold.sol` in that directory.
        #[sol(rpc, bytecode = "6080604052348015600e575f5ffd5b5060405161027a38038061027a833981016040819052602b916031565b5f556047565b5f602082840312156040575f5ffd5b5051919050565b610226806100545f395ff3fe608060405234801561000f575f5ffd5b5060043610610060575f3560e01c8063095ea7b31461006457806317757cc3146100b0578063647846a5146100d257806369fe0e2d146100e0578063dd62ed3e146100f4578063ddca3f431461011e575b5f5ffd5b61009b610072366004610141565b335f9081526001602081815260408084206001600160a01b039690961684529490529290205590565b60405190151581526020015b60405180910390f35b6100c46100be366004610169565b505f5490565b6040519081526020016100a7565b6040513081526020016100a7565b6100f26100ee3660046101a8565b5f55565b005b6100c46101023660046101bf565b600160209081525f928352604080842090915290825290205481565b6100c45f5481565b80356001600160a01b038116811461013c575f5ffd5b919050565b5f5f60408385031215610152575f5ffd5b61015b83610126565b946020939093013593505050565b5f60208284031215610179575f5ffd5b813567ffffffffffffffff81111561018f575f5ffd5b820161014081850312156101a1575f5ffd5b9392505050565b5f602082840312156101b8575f5ffd5b5035919050565b5f5f604083850312156101d0575f5ffd5b6101d983610126565b91506101e760208401610126565b9050925092905056fea2646970667358221220345c691adc05c0f6408a974813fb7a405e94ed28e33a82927e8f58129490422c64736f6c634300081e0033")]
        contract MockFeeInterfold {
            constructor(uint256 initialFee);
            function setFee(uint256 newFee) external;
            function allowance(address owner, address spender) external view returns (uint256);
        }
    }

    /// A node with a mock Interfold that quotes `fee`, and a contract handle that sends from a new
    /// funded key. A fresh key keeps the process-wide nonce tracker out of other tests. The mock
    /// belongs to another key: two providers of one key would not share a nonce.
    async fn chain(
        fee: u64,
    ) -> (
        InterfoldContract<ReadWrite>,
        MockFeeInterfold::MockFeeInterfoldInstance<impl Provider>,
        Address,
        AnvilInstance,
    ) {
        let anvil = Anvil::new().try_spawn().unwrap();
        let deployer = PrivateKeySigner::random();
        let requester = PrivateKeySigner::random();
        let provider = ProviderBuilder::new()
            .wallet(deployer.clone())
            .connect(&anvil.endpoint())
            .await
            .unwrap();
        for account in [deployer.address(), requester.address()] {
            provider
                .anvil_set_balance(account, U256::from(10).pow(U256::from(18)))
                .await
                .unwrap();
        }
        let mock = MockFeeInterfold::deploy(provider, U256::from(fee))
            .await
            .unwrap();
        let contract = InterfoldContract::new(
            &anvil.endpoint(),
            &format!("0x{}", hex::encode(requester.to_bytes())),
            &mock.address().to_string(),
        )
        .await
        .unwrap();
        (contract, mock, requester.address(), anvil)
    }

    async fn approve(contract: &InterfoldContract<ReadWrite>) -> U256 {
        let committee = committee(0).unwrap();
        approve_e3_fee(
            contract,
            committee,
            [U256::from(100), U256::from(200)],
            Address::ZERO,
            0,
            &Bytes::new(),
        )
        .await
        .unwrap()
    }

    #[tokio::test]
    async fn the_allowance_is_raised_to_the_quoted_fee() {
        let (contract, mock, owner, _anvil) = chain(5_000_000).await;
        let spender = *mock.address();
        assert_eq!(
            mock.allowance(owner, spender).call().await.unwrap(),
            U256::ZERO
        );

        assert_eq!(approve(&contract).await, U256::from(5_000_000));

        // Exactly the fee: a request spends it, and nothing more stays open.
        assert_eq!(
            mock.allowance(owner, spender).call().await.unwrap(),
            U256::from(5_000_000)
        );
    }

    #[tokio::test]
    async fn a_short_allowance_is_raised_and_a_covering_one_is_left_alone() {
        let (contract, mock, owner, _anvil) = chain(5_000_000).await;
        let spender = *mock.address();
        approve(&contract).await;

        // The fee rises above the allowance: it goes up to the new fee.
        mock.setFee(U256::from(7_000_000))
            .send()
            .await
            .unwrap()
            .watch()
            .await
            .unwrap();
        approve(&contract).await;
        assert_eq!(
            mock.allowance(owner, spender).call().await.unwrap(),
            U256::from(7_000_000)
        );

        // The fee falls below the allowance: no transaction is sent.
        mock.setFee(U256::from(1_000_000))
            .send()
            .await
            .unwrap()
            .watch()
            .await
            .unwrap();
        let block = contract.provider.get_block_number().await.unwrap();
        approve(&contract).await;
        assert_eq!(contract.provider.get_block_number().await.unwrap(), block);
        assert_eq!(
            mock.allowance(owner, spender).call().await.unwrap(),
            U256::from(7_000_000)
        );
    }
}
