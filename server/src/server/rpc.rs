// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

//! The process-wide HTTP client and Ethereum read providers.
//!
//! Every upstream request goes through one pooled client with a request timeout. Without the
//! timeout, a provider that accepts a connection and then stalls holds the caller until restart.

use std::sync::LazyLock;
use std::time::Duration;

use alloy::eips::BlockNumberOrTag;
use alloy::network::Ethereum;
use alloy::providers::{
    utils::Eip1559Estimation, DynProvider, PendingTransactionBuilder, Provider, ProviderBuilder,
    RootProvider, SendableTx,
};
use alloy::rpc::client::RpcClient;
use alloy::signers::local::PrivateKeySigner;
use alloy::transports::{http::Http, TransportErrorKind, TransportResult};
use tokio::sync::OnceCell;

use crate::config::CONFIG;

/// Upper bound on one upstream HTTP request, connection included.
pub const UPSTREAM_TIMEOUT: Duration = Duration::from_secs(20);

/// One pooled HTTP client for every outbound request of the process.
pub static HTTP: LazyLock<reqwest::Client> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(UPSTREAM_TIMEOUT)
        .build()
        .unwrap_or_else(|error| {
            log::error!("Could not build the bounded HTTP client, using the default: {error}");
            reqwest::Client::new()
        })
});

/// A read provider for `url` on the shared, timeout-bounded client. Builds no connection.
pub fn http_provider(url: &str) -> eyre::Result<DynProvider> {
    let url: reqwest::Url = url
        .parse()
        .map_err(|error| eyre::eyre!("the RPC URL is not a valid URL: {error}"))?;
    let transport = Http::with_client(HTTP.clone(), url);
    Ok(ProviderBuilder::new()
        .connect_client(RpcClient::new(transport, false))
        .erased())
}

/// The read provider for `HTTP_RPC_URL`, built once.
pub async fn provider() -> eyre::Result<&'static DynProvider> {
    static PROVIDER: OnceCell<DynProvider> = OnceCell::const_new();
    PROVIDER
        .get_or_try_init(|| async { http_provider(&CONFIG.http_rpc_url) })
        .await
}

/// A provider that signs with `signer` and sends to `url`, on the shared, timeout-bounded client.
pub fn wallet_provider(url: &str, signer: PrivateKeySigner) -> eyre::Result<DynProvider> {
    let url: reqwest::Url = url
        .parse()
        .map_err(|error| eyre::eyre!("the RPC URL is not a valid URL: {error}"))?;
    let transport = Http::with_client(HTTP.clone(), url);
    Ok(ProviderBuilder::new()
        .wallet(signer)
        .connect_client(RpcClient::new(transport, false))
        .erased())
}

/// The provider that sends transactions from the server key (`PRIVATE_KEY`) to `HTTP_RPC_URL`,
/// built once, with the server key's address. Transactions go through `send_with_next_nonce`, the
/// process-wide nonce sequence of that key.
pub async fn sender() -> eyre::Result<&'static (DynProvider, alloy::primitives::Address)> {
    static SENDER: OnceCell<(DynProvider, alloy::primitives::Address)> = OnceCell::const_new();
    SENDER
        .get_or_try_init(|| async {
            let signer: PrivateKeySigner = CONFIG
                .private_key
                .parse()
                .map_err(|error| eyre::eyre!("invalid server key: {error}"))?;
            let address = signer.address();
            Ok((wallet_provider(&CONFIG.http_rpc_url, signer)?, address))
        })
        .await
}

/// A wallet provider on the voting chain for the relay and the faucet. With
/// `GNOSIS_PRIORITY_FEE_WEI` set, its fee estimate is that tip over twice the latest base fee;
/// unset, alloy's estimate applies, whose 1 gwei tip floor makes a relayed ballot cost thousands of
/// times what a Gnosis chain charges.
pub fn gnosis_wallet_provider(url: &str, signer: PrivateKeySigner) -> eyre::Result<DynProvider> {
    let inner = wallet_provider(url, signer)?;
    Ok(match CONFIG.gnosis_priority_fee_wei {
        Some(tip) => FixedTipProvider::new(inner, u128::from(tip)).erased(),
        None => inner,
    })
}

/// A wallet provider whose EIP-1559 estimate is a fixed tip over twice the latest base fee.
///
/// The fee lives in the provider because `send_with_next_nonce` overwrites the fees of the call it
/// sends with `provider.estimate_eip1559_fees()`. Sends go to the wrapped provider, which signs;
/// reads use the default methods over its root.
#[derive(Clone)]
pub struct FixedTipProvider {
    inner: DynProvider,
    tip: u128,
}

impl FixedTipProvider {
    pub fn new(inner: DynProvider, tip: u128) -> Self {
        Self { inner, tip }
    }
}

#[async_trait::async_trait]
impl Provider for FixedTipProvider {
    fn root(&self) -> &RootProvider {
        self.inner.root()
    }

    async fn send_transaction_internal(
        &self,
        tx: SendableTx<Ethereum>,
    ) -> TransportResult<PendingTransactionBuilder<Ethereum>> {
        self.inner.send_transaction_internal(tx).await
    }

    async fn estimate_eip1559_fees(&self) -> TransportResult<Eip1559Estimation> {
        let base_fee = self
            .get_block_by_number(BlockNumberOrTag::Latest)
            .await?
            .and_then(|block| block.header.base_fee_per_gas)
            .ok_or_else(|| TransportErrorKind::custom_str("the latest block has no base fee"))?;
        Ok(Eip1559Estimation {
            max_fee_per_gas: u128::from(base_fee) * 2 + self.tip,
            max_priority_fee_per_gas: self.tip,
        })
    }
}

/// The timestamp of the latest block.
pub async fn latest_timestamp(provider: &impl Provider) -> eyre::Result<u64> {
    provider
        .get_block_by_number(BlockNumberOrTag::Latest)
        .await?
        .map(|block| block.header.timestamp)
        .ok_or_else(|| eyre::eyre!("the RPC returned no latest block"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy::consensus::Transaction as _;
    use alloy::contract::CallBuilder;
    use alloy::node_bindings::Anvil;
    use alloy::primitives::{Address, Bytes};

    /// `send_with_next_nonce` replaces the fees of the call it sends with the provider's estimate,
    /// so the tip must come from that estimate: alloy's own floors it at 1 gwei.
    #[tokio::test]
    async fn a_nonce_managed_send_pays_the_fixed_tip() {
        let anvil = Anvil::new().args(["--base-fee", "7"]).try_spawn().unwrap();
        let signer = PrivateKeySigner::from(anvil.keys()[0].clone());
        let from = signer.address();
        let wallet = wallet_provider(&anvil.endpoint(), signer).unwrap();
        let provider = FixedTipProvider::new(wallet, 1_000).erased();

        let call = CallBuilder::new_raw(&provider, Bytes::new()).to(Address::repeat_byte(1));
        let receipt = e3_sdk::evm::nonce::send_with_next_nonce(call, from)
            .await
            .unwrap()
            .get_receipt()
            .await
            .unwrap();

        let sent = provider
            .get_transaction_by_hash(receipt.transaction_hash)
            .await
            .unwrap()
            .unwrap();
        assert_eq!(sent.max_priority_fee_per_gas(), Some(1_000));
        assert!(sent.max_fee_per_gas() < 1_000_000);
        let block = provider
            .get_block_by_number(receipt.block_number.unwrap().into())
            .await
            .unwrap()
            .unwrap();
        let base_fee = u128::from(block.header.base_fee_per_gas.unwrap());
        assert_eq!(receipt.effective_gas_price, base_fee + 1_000);
    }
}
