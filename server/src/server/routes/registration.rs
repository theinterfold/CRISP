// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

//! The L1 ZKPassport registration relay of `PROGRAM_KIND=aztec`.
//!
//! A round of a `CRISPAztecProgram` can name a `ZKPassportRegistrar` as its registrar: the voter
//! proves a ZKPassport identity on L1, and the registrar sends the voter's slot to Aztec. The
//! proof binds the slot, not a sender, so anyone may submit it, and nobody can redirect it. This
//! route lets a voter who has no Ethereum wallet submit it through the server key.
//!
//! The route forwards `ZKPassportRegistrar.register` calldata to the configured registrar and
//! nothing else: the selector is fixed, the target is `ZKPASSPORT_REGISTRAR_ADDRESS`, and the
//! call is simulated first, so a proof the registrar would refuse costs nothing and the voter
//! learns why.

use actix_web::http::StatusCode;
use actix_web::{web, HttpRequest, HttpResponse, Responder};
use alloy::hex::encode_prefixed;
use alloy::network::TransactionBuilder;
use alloy::primitives::{Address, Bytes};
use alloy::providers::{DynProvider, Provider};
use alloy::rpc::types::TransactionRequest;
use alloy::sol;
use alloy::sol_types::{Revert, SolCall, SolError, SolInterface};
use alloy::transports::RpcError;
use log::{info, warn};

use super::chain::identify;
use super::json_message;
use crate::config::CONFIG;
use crate::server::models::{RegistrationRelayRequest, RegistrationRelayResponse};
use crate::server::rate_limit::RateLimiter;
use crate::server::rpc;

/// Largest request body: a `compressed-evm` proof and its public inputs are tens of kilobytes.
const REGISTRATION_JSON_LIMIT: usize = 512 * 1024;

sol! {
    /// The registrar's entry point, and the errors that its checks, and those of the program it
    /// calls, refuse with (`extensions/core/contracts/ZKPassportRegistrar.sol`).
    #[derive(Debug)]
    interface ZKPassportRegistrar {
        struct ProofVerificationData {
            bytes32 vkeyHash;
            bytes proof;
            bytes32[] publicInputs;
        }

        struct ServiceConfig {
            uint256 validityPeriodInSeconds;
            string domain;
            string scope;
            bool devMode;
        }

        struct ProofVerificationParams {
            bytes32 version;
            ProofVerificationData proofVerificationData;
            bytes committedInputs;
            ServiceConfig serviceConfig;
        }

        function register(
            uint256 e3Id,
            address slot,
            ProofVerificationParams params,
            string[] countries
        ) external;

        error NotRoundRegistrar(uint256 e3Id);
        error RegistrationClosed(uint256 e3Id);
        error CountriesMismatch();
        error InvalidProof();
        error MissingIdentifier();
        error UnexpectedNullifierType();
        error WrongBinding(address senderAddress, uint256 chainId);
        error AgeNotProven(uint256 minAge);
        error NationalityNotProven();
        error DocumentAlreadyRegistered(uint256 e3Id, bytes32 identifier);
    }

    /// Errors of `CRISPRemoteProgram.registerMember`, which the registrar calls last.
    #[derive(Debug)]
    interface ProgramRegistrationErrors {
        error CallerNotRegistrar(uint256 e3Id, address caller);
        error RegistrationClosed(uint256 e3Id);
        error L2ProgramNotSet();
    }
}

pub fn setup_routes(config: &mut web::ServiceConfig) {
    config.service(
        web::resource("/registration/l1")
            .app_data(web::JsonConfig::default().limit(REGISTRATION_JSON_LIMIT))
            .route(web::post().to(relay_registration)),
    );
}

/// Why the registrar refused `data`, or the raw revert data when it is none of its errors.
fn revert_reason(data: &[u8]) -> String {
    if let Ok(error) = ZKPassportRegistrar::ZKPassportRegistrarErrors::abi_decode(data) {
        return format!("{error:?}");
    }
    if let Ok(error) = ProgramRegistrationErrors::ProgramRegistrationErrorsErrors::abi_decode(data)
    {
        return format!("{error:?}");
    }
    match Revert::abi_decode(data) {
        Ok(revert) => format!("reverted: {}", revert.reason()),
        Err(_) => format!("reverted with {}", encode_prefixed(data)),
    }
}

/// What a failed simulation says: a revert is the voter's proof (400), anything else is the
/// relay's node (503).
fn simulation_failure(error: &RpcError<alloy::transports::TransportErrorKind>) -> HttpResponse {
    if let RpcError::ErrorResp(payload) = error {
        if let Some(data) = payload.as_revert_data() {
            return json_message(StatusCode::BAD_REQUEST, revert_reason(&data));
        }
        if payload.message.to_lowercase().contains("revert") {
            return json_message(StatusCode::BAD_REQUEST, payload.message.to_string());
        }
    }
    warn!("Registration simulation failed upstream: {error}");
    super::upstream_unavailable()
}

/// Relay `ZKPassportRegistrar.register` calldata from the server key.
async fn relay_registration(
    request: HttpRequest,
    data: web::Json<RegistrationRelayRequest>,
    limiter: web::Data<RateLimiter>,
) -> impl Responder {
    let Some(registrar) = CONFIG.zkpassport_registrar().filter(|_| CONFIG.is_aztec()) else {
        return HttpResponse::NotFound().finish();
    };
    let caller = identify(&request, CONFIG.trust_proxy_headers);
    if limiter.check_caller(&caller).is_err() {
        warn!("Rate limit (caller) refused a registration from {caller}");
        return json_message(
            StatusCode::TOO_MANY_REQUESTS,
            "Too many requests from this address, slow down",
        );
    }
    let (provider, sender) = match rpc::sender().await {
        Ok(sender) => sender,
        Err(error) => {
            warn!("Registration relay has no sender: {error:#}");
            return super::upstream_unavailable();
        }
    };
    relay(provider, *sender, registrar, &data.calldata).await
}

/// Check `calldata`, simulate it against `registrar` from `sender`, and send it.
async fn relay(
    provider: &DynProvider,
    sender: Address,
    registrar: Address,
    calldata: &str,
) -> HttpResponse {
    let Ok(calldata) = alloy::hex::decode(calldata.trim()) else {
        return json_message(StatusCode::BAD_REQUEST, "calldata is not hex");
    };
    if calldata.get(..4) != Some(&ZKPassportRegistrar::registerCall::SELECTOR[..]) {
        return json_message(
            StatusCode::BAD_REQUEST,
            "calldata is not a ZKPassportRegistrar.register call",
        );
    }
    let call = match ZKPassportRegistrar::registerCall::abi_decode(&calldata) {
        Ok(call) => call,
        Err(error) => {
            return json_message(
                StatusCode::BAD_REQUEST,
                format!("malformed register calldata: {error}"),
            )
        }
    };

    let calldata = Bytes::from(calldata);
    let simulation = TransactionRequest::default()
        .from(sender)
        .to(registrar)
        .with_input(calldata.clone());
    if let Err(error) = provider.call(simulation.clone()).await {
        return simulation_failure(&error);
    }
    // The estimate is the least gas the call succeeds with now. Sent with exactly that, a relayed registration ran out of
    // gas on the local network (the registrar reaches the Aztec Inbox through the program), which burns the server key's
    // fee and sends no MEMBER message, so leave a third of headroom.
    let gas = match provider.estimate_gas(simulation).await {
        Ok(gas) => gas,
        Err(error) => return simulation_failure(&error),
    };

    match broadcast(provider, sender, registrar, calldata, gas.saturating_add(gas / 3)).await {
        Ok(hash) => {
            let tx_hash = encode_prefixed(hash);
            info!(
                "[e3_id={}] Relayed the registration of slot {} to {registrar}: {tx_hash}",
                call.e3Id, call.slot
            );
            HttpResponse::Ok().json(RegistrationRelayResponse { tx_hash })
        }
        Err(error) => {
            warn!("Failed to send a registration: {error:#}");
            super::upstream_unavailable()
        }
    }
}

/// Registrations broadcast one at a time, so that two of them never read the same pending nonce.
static RELAY_TURN: tokio::sync::Mutex<()> = tokio::sync::Mutex::const_new(());

/// Broadcast `calldata` to `registrar` with exactly `gas`, and return the transaction hash.
///
/// `send_with_next_nonce` is not used: it replaces the gas limit with the bare estimate, which is what ran a relayed
/// registration out of gas. The nonce is the node's pending count, and `RELAY_TURN` keeps registrations from racing each
/// other for it; a send from elsewhere in this process at the same instant could still take the same nonce, and the
/// relay then answers 503 and the voter submits again.
async fn broadcast(
    provider: &DynProvider,
    sender: Address,
    registrar: Address,
    calldata: Bytes,
    gas: u64,
) -> eyre::Result<alloy::primitives::B256> {
    let _turn = RELAY_TURN.lock().await;
    let fees = provider.estimate_eip1559_fees().await?;
    let chain_id = provider.get_chain_id().await?;
    let nonce = provider.get_transaction_count(sender).pending().await?;
    let pending = alloy::contract::CallBuilder::new_raw(provider, calldata)
        .from(sender)
        .to(registrar)
        .gas(gas)
        .max_fee_per_gas(fees.max_fee_per_gas)
        .max_priority_fee_per_gas(fees.max_priority_fee_per_gas)
        .chain_id(chain_id)
        .nonce(nonce)
        .send()
        .await?;
    Ok(*pending.tx_hash())
}

#[cfg(test)]
mod tests {
    use super::*;
    use actix_web::body::to_bytes;
    use alloy::primitives::{bytes, B256, U256};
    use alloy::providers::{ext::AnvilApi, ProviderBuilder};
    use alloy::signers::local::PrivateKeySigner;

    fn register_calldata(e3_id: u64) -> String {
        use ZKPassportRegistrar::*;
        let call = registerCall {
            e3Id: U256::from(e3_id),
            slot: Address::repeat_byte(0x5a),
            params: ProofVerificationParams {
                version: B256::repeat_byte(1),
                proofVerificationData: ProofVerificationData {
                    vkeyHash: B256::repeat_byte(2),
                    proof: Bytes::from_static(&[1, 2, 3]),
                    publicInputs: vec![B256::repeat_byte(3)],
                },
                committedInputs: Bytes::from_static(&[4, 5]),
                serviceConfig: ServiceConfig {
                    validityPeriodInSeconds: U256::from(1),
                    domain: "poll.theinterfold.com".to_string(),
                    scope: "scope".to_string(),
                    devMode: true,
                },
            },
            countries: vec!["DEU".to_string()],
        };
        encode_prefixed(call.abi_encode())
    }

    async fn body(response: HttpResponse) -> (StatusCode, String) {
        let status = response.status();
        let bytes = to_bytes(response.into_body()).await.unwrap();
        (status, String::from_utf8(bytes.to_vec()).unwrap())
    }

    /// A node, a funded sender with its provider, and a registrar address with `code`.
    async fn chain(
        code: Bytes,
    ) -> (
        alloy::node_bindings::AnvilInstance,
        DynProvider,
        Address,
        Address,
    ) {
        let anvil = alloy::node_bindings::Anvil::new().try_spawn().unwrap();
        let signer = PrivateKeySigner::random();
        let sender = signer.address();
        let provider = ProviderBuilder::new()
            .wallet(signer)
            .connect(&anvil.endpoint())
            .await
            .unwrap();
        provider
            .anvil_set_balance(sender, U256::from(10).pow(U256::from(18)))
            .await
            .unwrap();
        let registrar = Address::repeat_byte(0x42);
        provider.anvil_set_code(registrar, code).await.unwrap();
        (anvil, provider.erased(), sender, registrar)
    }

    /// The selector the relay pins is the one of the registrar contract that the SDK, the keeper and the
    /// app encode against.
    #[test]
    fn the_pinned_selector_is_the_registrars_register() {
        let abi: alloy::json_abi::JsonAbi = serde_json::from_str(include_str!(
            "../../../../extensions/aztec/l1/abi/ZKPassportRegistrar.json"
        ))
        .unwrap();
        let register = abi.function("register").unwrap();
        assert_eq!(register.len(), 1);
        assert_eq!(
            register[0].selector().0,
            ZKPassportRegistrar::registerCall::SELECTOR
        );
    }

    #[test]
    fn a_refusal_of_the_registrar_or_the_program_names_its_error() {
        let refused = ZKPassportRegistrar::NotRoundRegistrar {
            e3Id: U256::from(7),
        };
        assert!(revert_reason(&refused.abi_encode()).starts_with("NotRoundRegistrar"));
        let closed = ProgramRegistrationErrors::CallerNotRegistrar {
            e3Id: U256::from(7),
            caller: Address::repeat_byte(1),
        };
        assert!(revert_reason(&closed.abi_encode()).starts_with("CallerNotRegistrar"));
        let plain = alloy::sol_types::Revert::from("salted nullifier");
        assert!(revert_reason(&plain.abi_encode()).contains("salted nullifier"));
        assert_eq!(revert_reason(&[0xde, 0xad]), "reverted with 0xdead");
    }

    #[actix_web::test]
    async fn it_forwards_only_register_calldata_to_the_registrar() {
        // STOP: accepts any call.
        let (_anvil, provider, sender, registrar) = chain(bytes!("00")).await;
        let calldata = register_calldata(1);

        // Not a register call: another selector, no selector, non-hex, a truncated argument list.
        for refused in [
            "0xa9059cbb".to_string(),
            "0x".to_string(),
            "not hex".to_string(),
            calldata[..calldata.len() - 64].to_string(),
        ] {
            let (status, _) = body(relay(&provider, sender, registrar, &refused).await).await;
            assert_eq!(status, StatusCode::BAD_REQUEST, "{refused}");
        }
        assert_eq!(provider.get_transaction_count(sender).await.unwrap(), 0);

        let (status, response) = body(relay(&provider, sender, registrar, &calldata).await).await;
        assert_eq!(status, StatusCode::OK, "{response}");
        let hash: RegistrationRelayResponse = serde_json::from_str(&response).unwrap();
        assert!(response.contains("txHash"));
        // The server key sent exactly the voter's calldata to the registrar.
        let tx = provider
            .get_transaction_by_hash(hash.tx_hash.parse().unwrap())
            .await
            .unwrap()
            .unwrap();
        use alloy::consensus::Transaction;
        assert_eq!(tx.to(), Some(registrar));
        assert_eq!(
            encode_prefixed(tx.input()),
            calldata,
            "the relay must not alter the calldata"
        );
    }

    #[actix_web::test]
    async fn a_registration_the_registrar_would_refuse_costs_nothing_and_says_why() {
        // Reverts with the calldata it received: a revert whose data is not one of its errors.
        let (_anvil, provider, sender, registrar) = chain(bytes!("365f5f37365ffd")).await;

        let (status, response) =
            body(relay(&provider, sender, registrar, &register_calldata(1)).await).await;

        assert_eq!(status, StatusCode::BAD_REQUEST, "{response}");
        assert!(response.contains("reverted with 0x"), "{response}");
        assert_eq!(provider.get_transaction_count(sender).await.unwrap(), 0);
    }
}
