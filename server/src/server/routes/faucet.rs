// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

//! `POST /faucet`: the voting token of a Gnosis instance, minted to the caller's address.
//!
//! The faucet is the account that the token authorises for `faucetMint`, on a key of its own
//! (`FAUCET_PRIVATE_KEY`): a key that can only mint cannot spend the relay's funds. The token
//! contract adds a cooldown per address, and the route limits callers and addresses
//! (`FaucetRateLimiter`). The route is mounted only when `FAUCET_ENABLED=true`.

use super::chain::identify;
use crate::server::{
    models::{FaucetRequest, FaucetResponse},
    rate_limit::FaucetRateLimiter,
    rpc, CONFIG,
};
use actix_web::{web, HttpRequest, HttpResponse, Responder};
use alloy::{
    primitives::{Address, U256},
    providers::DynProvider,
    signers::local::PrivateKeySigner,
    sol,
};
use e3_sdk::evm::nonce::send_with_next_nonce;
use log::{error, info, warn};
use serde_json::json;
use std::str::FromStr;
use tokio::sync::OnceCell;

sol! {
    #[sol(rpc)]
    interface IDemoToken {
        error NotFaucet(address caller);
        error FaucetCooldown(address recipient, uint256 availableAt);

        function faucetMint(address to) external;
        function faucetAmount() external view returns (uint256);
    }
}

pub fn setup_routes(config: &mut web::ServiceConfig) {
    if CONFIG.is_gnosis() && CONFIG.faucet_enabled {
        config.route("/faucet", web::post().to(claim));
    }
}

/// A claim that did not mint.
enum Refused {
    /// The token holds the address in its cooldown until this time.
    Cooldown(U256),
    /// The chain or the faucet account could not do it.
    Unavailable,
}

/// The faucet account's provider on the voting chain, built once, with its address.
async fn faucet_account() -> eyre::Result<&'static (DynProvider, Address)> {
    static ACCOUNT: OnceCell<(DynProvider, Address)> = OnceCell::const_new();
    ACCOUNT
        .get_or_try_init(|| async {
            let signer: PrivateKeySigner = CONFIG
                .faucet_private_key
                .as_deref()
                .ok_or_else(|| eyre::eyre!("FAUCET_PRIVATE_KEY is not set"))?
                .parse()
                .map_err(|_| eyre::eyre!("FAUCET_PRIVATE_KEY is not a private key"))?;
            let address = signer.address();
            Ok((rpc::gnosis_wallet_provider(&CONFIG.gnosis_rpc_url, signer)?, address))
        })
        .await
}

/// Wei one claim mints. `faucetAmount` is immutable, so it is read once: a later RPC failure
/// cannot make the config endpoint fail.
pub(super) async fn faucet_amount() -> eyre::Result<U256> {
    static AMOUNT: OnceCell<U256> = OnceCell::const_new();
    AMOUNT
        .get_or_try_init(|| async {
            let provider = rpc::http_provider(&CONFIG.gnosis_rpc_url)?;
            Ok(IDemoToken::new(CONFIG.gnosis_token()?, provider)
                .faucetAmount()
                .call()
                .await?)
        })
        .await
        .copied()
}

/// Mint the faucet amount to `to`, after a dry run that finds a cooldown without a transaction.
async fn mint(to: Address) -> Result<FaucetResponse, Refused> {
    let unavailable = |error: eyre::Report| {
        error!("The faucet could not mint to {to}: {error:#}");
        Refused::Unavailable
    };
    let (provider, from) = faucet_account().await.map_err(unavailable)?;
    let token = IDemoToken::new(
        CONFIG.gnosis_token().map_err(|e| unavailable(e.into()))?,
        provider.clone(),
    );
    let amount = token
        .faucetAmount()
        .call()
        .await
        .map_err(|e| unavailable(e.into()))?;

    if let Err(error) = token.faucetMint(to).from(*from).call().await {
        return Err(
            match error.as_decoded_interface_error::<IDemoToken::IDemoTokenErrors>() {
                Some(IDemoToken::IDemoTokenErrors::FaucetCooldown(cooldown)) => {
                    Refused::Cooldown(cooldown.availableAt)
                }
                _ => unavailable(error.into()),
            },
        );
    }
    let receipt = send_with_next_nonce(token.faucetMint(to), *from)
        .await
        .map_err(unavailable)?
        .get_receipt()
        .await
        .map_err(|e| unavailable(e.into()))?;
    if !receipt.status() {
        return Err(unavailable(eyre::eyre!("faucetMint reverted")));
    }
    Ok(FaucetResponse {
        tx_hash: receipt.transaction_hash.to_string(),
        amount: amount.to_string(),
    })
}

fn message(status: actix_web::http::StatusCode, text: impl Into<String>) -> HttpResponse {
    HttpResponse::build(status).json(json!({ "message": text.into() }))
}

async fn claim(
    request: HttpRequest,
    data: web::Json<FaucetRequest>,
    limiter: web::Data<FaucetRateLimiter>,
) -> impl Responder {
    use actix_web::http::StatusCode;

    let to = match Address::from_str(data.address.trim()) {
        Ok(to) if !to.is_zero() => to,
        _ => return message(StatusCode::BAD_REQUEST, "Invalid address"),
    };
    let caller = identify(&request, CONFIG.trust_proxy_headers);
    if limiter.check(&caller, &to.to_string()).is_err() {
        warn!("Rate limit refused a faucet claim from {caller}");
        return message(
            StatusCode::TOO_MANY_REQUESTS,
            "Too many claims, try again later",
        );
    }

    match mint(to).await {
        Ok(response) => {
            info!("The faucet minted {} to {to}", response.amount);
            HttpResponse::Ok().json(response)
        }
        Err(Refused::Cooldown(available_at)) => message(
            StatusCode::TOO_MANY_REQUESTS,
            format!("This address claimed recently; it can claim again at {available_at}"),
        ),
        Err(Refused::Unavailable) => message(
            StatusCode::SERVICE_UNAVAILABLE,
            "The faucet is temporarily unavailable",
        ),
    }
}
