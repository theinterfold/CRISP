// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

//! The parts of an E3 round request that the `/rounds/request` route and the CLI share.
//!
//! Each caller still owns its compute-provider-params encoding (bincode on the server, JSON in
//! the CLI).

use alloy::primitives::{Address, Bytes, U256};
use alloy::rpc::types::TransactionReceipt;
use alloy::sol;
use alloy::sol_types::SolValue;
use e3_sdk::evm::contracts::{
    CommitteeSize, Interfold, InterfoldContract, InterfoldRead, InterfoldWrite, ReadWrite,
};
use e3_sdk::evm::nonce::send_with_next_nonce;
use evm_helpers::CRISPContract;
use log::{error, info, warn};
use serde::Serialize;
use std::future::Future;

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

/// What `approve_e3_fee` quoted, and whether it had to send an approval transaction.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FeeApproval {
    pub fee: U256,
    /// `true` if a transaction was mined: time has passed since the quote was taken.
    pub sent: bool,
}

/// Let Interfold pull the fee of the round that `request_e3` is about to send.
///
/// `Interfold.request` takes the fee from the requester, which is the key of `contract`, with
/// `feeToken.transferFrom`. Without an allowance the request reverts with
/// `ERC20InsufficientAllowance`. The fee is quoted for `input_window`, and the same window must
/// go to `request_e3`: the fee never grows as the chain clock moves toward the window's end, so
/// the quote bounds the fee that the request charges. The allowance is raised to exactly the
/// quote, not to the maximum, so a fresh approval is spent by the request. An allowance that
/// already covers the quote is left as it is, and no transaction is sent; if the fee falls later,
/// the surplus of such an allowance stays approved. The approval is read back, because an ERC-20
/// `approve` may return `false` without reverting.
pub async fn approve_e3_fee(
    contract: &InterfoldContract<ReadWrite>,
    committee: Committee,
    input_window: [U256; 2],
    e3_program: Address,
    param_set: u8,
    compute_provider_params: &Bytes,
) -> eyre::Result<FeeApproval> {
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
        return Ok(FeeApproval { fee, sent: false });
    }

    info!("Approving {fee} of fee token {fee_token} for Interfold {spender}");
    let receipt = send_with_next_nonce(token.approve(spender, fee), owner)
        .await?
        .get_receipt()
        .await?;
    eyre::ensure!(receipt.status(), "fee token approval reverted");
    let approved = token.allowance(owner, spender).call().await?;
    eyre::ensure!(
        approved >= fee,
        "fee token approval left an allowance of {approved}, below the fee of {fee}"
    );
    info!("Fee token approved. TxHash: {:?}", receipt.transaction_hash);
    Ok(FeeApproval { fee, sent: true })
}

/// How many times `settle_fee_and_window` takes a window and approves its fee.
const MAX_WINDOW_ATTEMPTS: usize = 3;

/// The input window of the round to request, with the fee of that window approved.
///
/// The window starts `voting_start_buffer_seconds` after the earliest start that the program
/// allows, and the buffer must outlast the time that `request_e3` takes to mine. An approval is a
/// transaction of its own, and the time it takes is spent from that buffer: on a slow chain,
/// `request_e3` would revert with `VotingStartsBeforeKeyDeadline`. When an approval was sent, the
/// window is taken again and its fee is checked against the allowance again: the new window needs
/// a new approval only if its quote is higher. The window returned is one whose fee needed no
/// transaction, so only reads stand between it and `request_e3`.
async fn settle_fee_and_window(
    contract: &InterfoldContract<ReadWrite>,
    program: &CRISPContract,
    committee: Committee,
    e3_program: Address,
    param_set: u8,
    compute_provider_params: &Bytes,
) -> eyre::Result<[U256; 2]> {
    settle_window(
        || voting_window(program),
        |window| {
            approve_e3_fee(
                contract,
                committee,
                window,
                e3_program,
                param_set,
                compute_provider_params,
            )
        },
    )
    .await
}

async fn settle_window<W, WF, A, AF>(mut next_window: W, mut approve: A) -> eyre::Result<[U256; 2]>
where
    W: FnMut() -> WF,
    WF: Future<Output = eyre::Result<[U256; 2]>>,
    A: FnMut([U256; 2]) -> AF,
    AF: Future<Output = eyre::Result<FeeApproval>>,
{
    for attempt in 1..=MAX_WINDOW_ATTEMPTS {
        let window = next_window().await?;
        if !approve(window).await?.sent {
            return Ok(window);
        }
        warn!("Fee approval took time (attempt {attempt}/{MAX_WINDOW_ATTEMPTS}); taking the voting window again");
    }
    eyre::bail!(
        "the fee needed a new approval for each of {MAX_WINDOW_ATTEMPTS} voting windows; try again"
    )
}

/// Selector of `CRISPProgram.VotingStartsBeforeKeyDeadline(uint256,uint256,uint256)`.
const VOTING_STARTS_BEFORE_KEY_DEADLINE_SELECTOR: &str = "0x56d12960";

/// Settle the fee and window of a round, then request it.
///
/// Reads stand between the window and the request, and the request takes time to mine; all of it
/// is spent from the start buffer. When the program refuses the window with
/// `VotingStartsBeforeKeyDeadline`, the refused request left no round behind, so the fee and window
/// are settled again and the round is requested with the fresh window.
pub async fn request_round(
    contract: &InterfoldContract<ReadWrite>,
    program: &CRISPContract,
    committee: Committee,
    e3_program: Address,
    param_set: u8,
    compute_provider_params: &Bytes,
    custom_params: &Bytes,
) -> eyre::Result<(TransactionReceipt, U256)> {
    retry_refused_windows(|| async {
        let window = settle_fee_and_window(
            contract,
            program,
            committee,
            e3_program,
            param_set,
            compute_provider_params,
        )
        .await?;
        info!(
            "Requesting E3 with input window [{}, {}] (buffer {}s)",
            window[0], window[1], CONFIG.voting_start_buffer_seconds
        );
        contract
            .request_e3(
                committee.size,
                window,
                e3_program,
                param_set,
                compute_provider_params.clone(),
                custom_params.clone(),
            )
            .await
    })
    .await
}

async fn retry_refused_windows<R, F, Fut>(mut request: F) -> eyre::Result<R>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = eyre::Result<R>>,
{
    let mut attempt = 1;
    loop {
        match request().await {
            Err(err)
                if attempt < MAX_WINDOW_ATTEMPTS
                    && format!("{err:#}").contains(VOTING_STARTS_BEFORE_KEY_DEADLINE_SELECTOR) =>
            {
                warn!("The voting window started before the key deadline (attempt {attempt}/{MAX_WINDOW_ATTEMPTS}); requesting with a fresh window");
                attempt += 1;
            }
            result => return result,
        }
    }
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
        #[sol(rpc, bytecode = "6080604052348015600e575f5ffd5b506040516105eb3803806105eb833981016040819052602b916081565b6040516035906074565b604051809103905ff080158015604d573d5f5f3e3d5ffd5b505f80546001600160a01b0319166001600160a01b03929092169190911790556001556097565b610208806103e383390190565b5f602082840312156090575f5ffd5b5051919050565b61033f806100a45f395ff3fe608060405234801561000f575f5ffd5b506004361061007a575f3560e01c80639035e450116100585780639035e450146100e35780639e21a94f146100f6578063d7da284e14610115578063ddca3f4314610128575f5ffd5b806317757cc31461007e578063647846a5146100a457806369fe0e2d146100ce575b5f5ffd5b61009161008c36600461024e565b610131565b6040519081526020015b60405180910390f35b5f546100b6906001600160a01b031681565b6040516001600160a01b03909116815260200161009b565b6100e16100dc36600461028d565b600155565b005b6100916100f136600461028d565b6101c4565b6002546101039060ff1681565b60405160ff909116815260200161009b565b6100e16101233660046102b9565b6101da565b61009160015481565b6002545f9060ff1661014660208401846102f0565b60ff1614801561015b57506003546020830135145b801561016c57506004546040830135145b6101bc5760405162461bcd60e51b815260206004820152601a60248201527f756e65787065637465642071756f746520617267756d656e7473000000000000604482015260640160405180910390fd5b505060015490565b600381600281106101d3575f80fd5b0154905081565b6002805460ff191660ff84161781556101f79060039083906101fc565b505050565b826002810192821561022a579160200282015b8281111561022a57823582559160200191906001019061020f565b5061023692915061023a565b5090565b5b80821115610236575f815560010161023b565b5f6020828403121561025e575f5ffd5b813567ffffffffffffffff811115610274575f5ffd5b82016101408185031215610286575f5ffd5b9392505050565b5f6020828403121561029d575f5ffd5b5035919050565b803560ff811681146102b4575f5ffd5b919050565b5f5f606083850312156102ca575f5ffd5b6102d3836102a4565b9150836060840111156102e4575f5ffd5b50926020919091019150565b5f60208284031215610300575f5ffd5b610286826102a456fea2646970667358221220106fab8bc78a039a1b50837cee59bc6d1c6d1049d49dc5aeb142f1575a8a242264736f6c634300081e00336080604052348015600e575f5ffd5b506101ec8061001c5f395ff3fe608060405234801561000f575f5ffd5b506004361061004a575f3560e01c8063095ea7b31461004e578063b0b98b6514610076578063bf5b65b314610099578063dd62ed3e146100a6575b5f5ffd5b61006161005c366004610137565b6100db565b60405190151581526020015b60405180910390f35b61009761008436600461015f565b6001805460ff1916911515919091179055565b005b6001546100619060ff1681565b6100cd6100b4366004610185565b5f60208181529281526040808220909352908152205481565b60405190815260200161006d565b6001545f9060ff16156100ef57505f610116565b50335f908152602081815260408083206001600160a01b0386168452909152902081905560015b92915050565b80356001600160a01b0381168114610132575f5ffd5b919050565b5f5f60408385031215610148575f5ffd5b6101518361011c565b946020939093013593505050565b5f6020828403121561016f575f5ffd5b8135801515811461017e575f5ffd5b9392505050565b5f5f60408385031215610196575f5ffd5b61019f8361011c565b91506101ad6020840161011c565b9050925092905056fea264697066735822122023fa280adf22830484f94173ba5b68ae1247bc965cdb25f0d4f5bbe69b6ea12664736f6c634300081e0033")]
        contract MockFeeInterfold {
            constructor(uint256 initialFee);
            function setFee(uint256 newFee) external;
            function expectQuote(uint8 committeeSize, uint256[2] inputWindow) external;
            function feeToken() external view returns (address);
        }

        #[sol(rpc)]
        contract MockFeeToken {
            function allowance(address owner, address spender) external view returns (uint256);
            function setRefusesApprovals(bool refuses) external;
        }
    }

    /// The committee size and input window that `chain` makes the mock expect in a quote.
    const QUOTED_COMMITTEE: u8 = 0;
    const QUOTED_WINDOW: [u64; 2] = [100, 200];

    /// A node with a mock Interfold that quotes `fee`, its fee token, and a contract handle that
    /// sends from a new funded key. A fresh key keeps the process-wide nonce tracker out of other
    /// tests. The mock belongs to another key: two providers of one key would not share a nonce.
    async fn chain(
        fee: u64,
    ) -> (
        InterfoldContract<ReadWrite>,
        MockFeeInterfold::MockFeeInterfoldInstance<impl Provider>,
        MockFeeToken::MockFeeTokenInstance<impl Provider>,
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
        let mock = MockFeeInterfold::deploy(provider.clone(), U256::from(fee))
            .await
            .unwrap();
        mock.expectQuote(QUOTED_COMMITTEE, QUOTED_WINDOW.map(U256::from))
            .send()
            .await
            .unwrap()
            .watch()
            .await
            .unwrap();
        let token = MockFeeToken::new(mock.feeToken().call().await.unwrap(), provider);
        assert_ne!(*token.address(), *mock.address());
        let contract = InterfoldContract::new(
            &anvil.endpoint(),
            &format!("0x{}", hex::encode(requester.to_bytes())),
            &mock.address().to_string(),
        )
        .await
        .unwrap();
        (contract, mock, token, requester.address(), anvil)
    }

    async fn try_approve(
        contract: &InterfoldContract<ReadWrite>,
        committee_size: u8,
        window: [u64; 2],
    ) -> eyre::Result<FeeApproval> {
        approve_e3_fee(
            contract,
            committee(committee_size).unwrap(),
            window.map(U256::from),
            Address::ZERO,
            0,
            &Bytes::new(),
        )
        .await
    }

    async fn approve(contract: &InterfoldContract<ReadWrite>) -> FeeApproval {
        try_approve(contract, QUOTED_COMMITTEE, QUOTED_WINDOW)
            .await
            .unwrap()
    }

    #[tokio::test]
    async fn the_allowance_is_raised_to_the_quoted_fee() {
        let (contract, mock, token, owner, _anvil) = chain(5_000_000).await;
        let spender = *mock.address();
        assert_eq!(
            token.allowance(owner, spender).call().await.unwrap(),
            U256::ZERO
        );

        assert_eq!(
            approve(&contract).await,
            FeeApproval {
                fee: U256::from(5_000_000),
                sent: true
            }
        );

        // Exactly the fee: a request spends it, and nothing more stays open. The approval is on
        // the fee token, not on the Interfold contract.
        assert_eq!(
            token.allowance(owner, spender).call().await.unwrap(),
            U256::from(5_000_000)
        );
    }

    #[tokio::test]
    async fn a_short_allowance_is_raised_and_a_covering_one_is_left_alone() {
        let (contract, mock, token, owner, _anvil) = chain(5_000_000).await;
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
        assert!(approve(&contract).await.sent);
        assert_eq!(
            token.allowance(owner, spender).call().await.unwrap(),
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
        assert_eq!(
            approve(&contract).await,
            FeeApproval {
                fee: U256::from(1_000_000),
                sent: false
            }
        );
        assert_eq!(contract.provider.get_block_number().await.unwrap(), block);
        assert_eq!(
            token.allowance(owner, spender).call().await.unwrap(),
            U256::from(7_000_000)
        );
    }

    #[tokio::test]
    async fn an_approval_that_leaves_the_allowance_short_is_an_error() {
        let (contract, mock, token, owner, _anvil) = chain(5_000_000).await;
        // `approve` returns false and mines without a revert, as a non-conforming token may.
        token
            .setRefusesApprovals(true)
            .send()
            .await
            .unwrap()
            .watch()
            .await
            .unwrap();

        let err = try_approve(&contract, QUOTED_COMMITTEE, QUOTED_WINDOW)
            .await
            .unwrap_err();

        assert!(err.to_string().contains("below the fee"), "{err}");
        assert_eq!(
            token
                .allowance(owner, *mock.address())
                .call()
                .await
                .unwrap(),
            U256::ZERO
        );
    }

    #[tokio::test]
    async fn the_quote_is_taken_for_the_committee_and_window_of_the_request() {
        let (contract, _mock, _token, _owner, _anvil) = chain(5_000_000).await;

        // The mock reverts a quote for any other committee or window.
        assert!(try_approve(&contract, QUOTED_COMMITTEE + 1, QUOTED_WINDOW)
            .await
            .is_err());
        assert!(try_approve(&contract, QUOTED_COMMITTEE, [100, 201])
            .await
            .is_err());
    }

    /// A window source whose windows start 10 seconds later each time it is read, as the clock
    /// does while an approval is mined.
    fn clock(
        reads: &std::cell::Cell<u64>,
    ) -> impl FnMut() -> std::future::Ready<eyre::Result<[U256; 2]>> + '_ {
        move || {
            let read = reads.get();
            reads.set(read + 1);
            std::future::ready(Ok([
                U256::from(100 + 10 * read),
                U256::from(200 + 10 * read),
            ]))
        }
    }

    fn approval(sent: bool) -> std::future::Ready<eyre::Result<FeeApproval>> {
        std::future::ready(Ok(FeeApproval {
            fee: U256::from(1),
            sent,
        }))
    }

    #[tokio::test]
    async fn a_window_whose_approval_needed_no_transaction_is_used_as_taken() {
        let reads = std::cell::Cell::new(0);

        let window = settle_window(clock(&reads), |_| approval(false))
            .await
            .unwrap();

        assert_eq!(window, [U256::from(100), U256::from(200)]);
        assert_eq!(reads.get(), 1);
    }

    #[tokio::test]
    async fn the_window_is_taken_again_after_an_approval_took_time() {
        let reads = std::cell::Cell::new(0);
        let mut approved = Vec::new();

        // The first window needs a transaction, so by the time it is mined that window's buffer is
        // spent. The second window's fee is covered by the allowance that the first one raised.
        let window = settle_window(clock(&reads), |window| {
            approved.push(window);
            approval(approved.len() == 1)
        })
        .await
        .unwrap();

        assert_eq!(window, [U256::from(110), U256::from(210)]);
        assert_eq!(approved.len(), 2);
        assert_eq!(approved[1], window);
    }

    #[tokio::test]
    async fn the_window_is_not_taken_again_forever() {
        let reads = std::cell::Cell::new(0);

        let err = settle_window(clock(&reads), |_| approval(true))
            .await
            .unwrap_err();

        assert_eq!(reads.get(), MAX_WINDOW_ATTEMPTS as u64);
        assert!(err.to_string().contains("new approval"), "{err}");
    }

    /// A request that the program refuses `refusals` times with `VotingStartsBeforeKeyDeadline`.
    fn refusing(
        refusals: usize,
        calls: &std::cell::Cell<usize>,
    ) -> impl FnMut() -> std::future::Ready<eyre::Result<u8>> + '_ {
        move || {
            let call = calls.get();
            calls.set(call + 1);
            std::future::ready(if call < refusals {
                Err(eyre::eyre!(
                    "execution reverted: custom error {VOTING_STARTS_BEFORE_KEY_DEADLINE_SELECTOR}"
                ))
            } else {
                Ok(7)
            })
        }
    }

    #[tokio::test]
    async fn a_refused_window_is_requested_again_with_a_fresh_one() {
        let calls = std::cell::Cell::new(0);

        let result = retry_refused_windows(refusing(1, &calls)).await.unwrap();

        assert_eq!(result, 7);
        assert_eq!(calls.get(), 2);
    }

    #[tokio::test]
    async fn other_request_errors_are_not_retried() {
        let calls = std::cell::Cell::new(0);

        let err = retry_refused_windows(|| {
            calls.set(calls.get() + 1);
            std::future::ready(Err::<u8, _>(eyre::eyre!("execution reverted: 0x44ec930f")))
        })
        .await
        .unwrap_err();

        assert_eq!(calls.get(), 1);
        assert!(err.to_string().contains("0x44ec930f"), "{err}");
    }

    #[tokio::test]
    async fn refused_windows_are_not_retried_forever() {
        let calls = std::cell::Cell::new(0);

        let err = retry_refused_windows(refusing(usize::MAX, &calls))
            .await
            .unwrap_err();

        assert_eq!(calls.get(), MAX_WINDOW_ATTEMPTS);
        assert!(
            err.to_string()
                .contains(VOTING_STARTS_BEFORE_KEY_DEADLINE_SELECTOR),
            "{err}"
        );
    }
}
