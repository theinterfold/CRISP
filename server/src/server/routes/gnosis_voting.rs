// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

//! The voting routes of a Gnosis instance: `POST /voting/broadcast` and the client config.

use super::{
    chain::identify,
    faucet::faucet_amount,
    voting::{availability_error, failed},
};
use crate::server::{
    data_availability::{AvailabilityService, GnosisBroadcast},
    models::{
        e3_id_to_u256, FaucetConfig, GnosisInputConfig, VoteRequest, VoteResponse,
        VoteResponseStatus,
    },
    rate_limit::RateLimiter,
    CONFIG,
};
use actix_web::{web, HttpRequest, HttpResponse, Responder};
use alloy::hex::encode_prefixed;
use log::{error, info, warn};

/// Accept a ballot for the voting contract on the Gnosis chain.
///
/// The answer is synchronous. The ballot is checked with a dry run of the contract, so a ballot
/// the contract would refuse is a 400 and costs no transaction. An accepted ballot is either sent
/// from the relay key (`success` with the transaction hash) or handed back as the payload of
/// `publishInput(e3Id, payload)` for the voter's wallet to send (`ready_for_commitment`): the
/// voter asked for it, or the relay is off, past a limit, or out of funds. Callers are limited
/// like any broadcast, and the global window only decides whether the relay may send.
pub(super) async fn broadcast(
    request: HttpRequest,
    data: web::Json<VoteRequest>,
    limiter: web::Data<RateLimiter>,
    availability: web::Data<AvailabilityService>,
) -> impl Responder {
    let caller = identify(&request, CONFIG.trust_proxy_headers);
    if limiter.check_caller(&caller).is_err() {
        warn!("Rate limit (caller) refused a broadcast from {caller}");
        return HttpResponse::TooManyRequests()
            .json(failed("Too many votes from this address, slow down"));
    }

    let vote = data.into_inner();
    let e3_id = match e3_id_to_u256(&vote.round_id) {
        Ok(e3_id) => e3_id,
        Err(e) => return HttpResponse::BadRequest().json(e.to_string()),
    };
    let e3_key = e3_id.to_string();
    let Ok(encoded_proof) = hex::decode(
        vote.encoded_proof
            .strip_prefix("0x")
            .unwrap_or(&vote.encoded_proof),
    ) else {
        return HttpResponse::BadRequest().json(failed("Invalid hex encoded proof"));
    };

    info!("[e3_id={e3_key}] Broadcasting a Gnosis ballot");
    // Past the global window the ballot is still accepted, and the voter's wallet sends it.
    let reservation = limiter.try_reserve_global().ok();
    match availability
        .broadcast_gnosis(&e3_key, &encoded_proof, vote.send_from_wallet, reservation)
        .await
    {
        Ok(GnosisBroadcast::Relayed { tx_hash }) => HttpResponse::Ok().json(VoteResponse {
            status: VoteResponseStatus::Success,
            tx_hash: Some(tx_hash),
            job_id: None,
            encoded_proof: None,
            message: None,
        }),
        Ok(GnosisBroadcast::Wallet { payload }) => HttpResponse::Ok().json(VoteResponse {
            status: VoteResponseStatus::ReadyForCommitment,
            tx_hash: None,
            job_id: None,
            encoded_proof: Some(encode_prefixed(payload)),
            message: None,
        }),
        Err(error) => availability_error(&e3_key, &error),
    }
}

/// What a client needs to vote on the Gnosis chain: the contracts, the chain, the attestation
/// signer, and the faucet. 404 on a server that does not serve the Gnosis program.
pub(super) async fn config(availability: &AvailabilityService) -> HttpResponse {
    let (Some((signer, _)), Ok(voting), Ok(token)) = (
        availability.remote_signer(),
        CONFIG.gnosis_voting(),
        CONFIG.gnosis_token(),
    ) else {
        return HttpResponse::NotFound().finish();
    };
    let amount = if CONFIG.faucet_enabled {
        match faucet_amount().await {
            Ok(amount) => amount.to_string(),
            Err(error) => {
                error!("Could not read the faucet amount: {error:#}");
                return HttpResponse::ServiceUnavailable().finish();
            }
        }
    } else {
        "0".to_owned()
    };
    HttpResponse::Ok().json(GnosisInputConfig {
        kind: "gnosis".to_owned(),
        chain_id: CONFIG.gnosis_chain_id,
        voting_address: voting.to_string(),
        token_address: token.to_string(),
        rpc_url: CONFIG.gnosis_public_rpc_url.clone(),
        explorer_url: CONFIG.gnosis_explorer_url.clone(),
        program: CONFIG.e3_program_address.clone(),
        sepolia_program: CONFIG.e3_program_address.clone(),
        attestation_ttl: CONFIG.gnosis_attestation_ttl_seconds,
        signer: signer.to_string(),
        faucet: FaucetConfig {
            enabled: CONFIG.faucet_enabled,
            amount,
        },
    })
}
