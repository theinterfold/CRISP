// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

//! `POST /voting/remote-input/enroll`: the relay of `CRISPAztecVotesProgram.enroll`, which is
//! permissionless and cannot forge a weight. The route only saves voters the gas: it keeps the slots
//! that still need enrolling and sends one `enroll(e3Id, slots)` from the server key. A voter whose
//! request the relay refuses sends the same call themselves.

use super::{chain::identify, json_message};
use crate::{
    config::Config,
    server::{models::e3_id_to_u256, rate_limit::RateLimiter, rpc},
};
use actix_web::{http::StatusCode, web, HttpRequest, HttpResponse};
use alloy::{
    primitives::{Address, B256, U256},
    sol,
};
use async_trait::async_trait;
use log::{error, info, warn};
use serde::{Deserialize, Serialize};
use std::{
    collections::HashSet,
    sync::{Arc, Mutex, PoisonError},
    time::Duration,
};

sol! {
    /// The part of `CRISPAztecVotesProgram` the relay uses.
    #[sol(rpc)]
    interface IAztecVotesProgram {
        function enroll(uint256 e3Id, address[] calldata slots) external returns (uint256 enrolled);
        function isEnrolled(uint256 e3Id, address slot) external view returns (bool);
        function weightOf(uint256 e3Id, address slot) external view returns (uint256);
    }
}

/// The most slots one request may name: a voter needs their own slot and a few masks.
const MAX_SLOTS: usize = 32;
/// Requests one caller may make per window.
const PER_CALLER_LIMIT: usize = 6;
/// Requests all callers together may make for one round per window. The relay spends gas for
/// them, so a round has its own budget besides the caller's.
const PER_ROUND_LIMIT: usize = 60;
/// How long the relay waits for its transaction to be mined before it answers.
const RECEIPT_TIMEOUT: Duration = Duration::from_secs(180);

#[derive(Deserialize)]
pub struct EnrollRequest {
    /// The Interfold E3 id, decimal.
    pub round_id: String,
    pub slots: Vec<String>,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct Skipped {
    pub slot: Address,
    /// `enrolled`, `no_weight` (the slot holds nothing at the snapshot, or less than the floor) or
    /// `in_flight` (an enrollment of the slot is on its way).
    pub reason: &'static str,
}

#[derive(Serialize)]
pub struct EnrollResponse {
    /// The relay's transaction, `null` when no slot needed one.
    pub tx_hash: Option<B256>,
    pub enrolled: Vec<Address>,
    pub skipped: Vec<Skipped>,
}

/// What the votes program knows of one slot of a round.
pub struct SlotState {
    pub enrolled: bool,
    pub weight: U256,
}

/// The L1 side of the relay.
#[async_trait]
pub trait VotesChain: Send + Sync {
    /// The state of every slot, in order.
    async fn slot_states(&self, e3_id: U256, slots: &[Address]) -> eyre::Result<Vec<SlotState>>;
    /// Send `enroll(e3Id, slots)` and wait until it is mined.
    async fn enroll(&self, e3_id: U256, slots: &[Address]) -> eyre::Result<B256>;
}

/// Reads with the shared provider of `HTTP_RPC_URL` and sends from the server key.
struct L1Votes {
    program: Address,
}

#[async_trait]
impl VotesChain for L1Votes {
    async fn slot_states(&self, e3_id: U256, slots: &[Address]) -> eyre::Result<Vec<SlotState>> {
        let provider = rpc::provider().await?;
        let reads: Vec<_> = slots
            .iter()
            .map(|&slot| {
                let program = IAztecVotesProgram::new(self.program, provider);
                tokio::spawn(async move {
                    let is_enrolled = program.isEnrolled(e3_id, slot);
                    let weight_of = program.weightOf(e3_id, slot);
                    tokio::join!(is_enrolled.call(), weight_of.call())
                })
            })
            .collect();
        let mut states = Vec::with_capacity(reads.len());
        for read in reads {
            let (enrolled, weight) = read.await?;
            states.push(SlotState {
                enrolled: enrolled?,
                weight: weight?,
            });
        }
        Ok(states)
    }

    async fn enroll(&self, e3_id: U256, slots: &[Address]) -> eyre::Result<B256> {
        let (provider, from) = rpc::sender().await?;
        let program = IAztecVotesProgram::new(self.program, provider);
        let pending = e3_sdk::evm::nonce::send_with_next_nonce(
            program.enroll(e3_id, slots.to_vec()),
            *from,
        )
        .await?;
        let receipt = tokio::time::timeout(RECEIPT_TIMEOUT, pending.get_receipt())
            .await
            .map_err(|_| eyre::eyre!("the enroll transaction was not mined in time"))??;
        eyre::ensure!(receipt.status(), "the enroll transaction reverted");
        Ok(receipt.transaction_hash)
    }
}

/// The relay's shared state: the chain, the limits and the enrollments in flight.
pub struct EnrollService {
    chain: Arc<dyn VotesChain>,
    callers: RateLimiter,
    rounds: RateLimiter,
    in_flight: Mutex<HashSet<(U256, Address)>>,
    trust_proxy_headers: bool,
}

impl EnrollService {
    pub fn new(chain: Arc<dyn VotesChain>, trust_proxy_headers: bool) -> Self {
        Self {
            chain,
            callers: RateLimiter::with_limits(PER_CALLER_LIMIT, usize::MAX),
            rounds: RateLimiter::with_limits(PER_ROUND_LIMIT, usize::MAX),
            in_flight: Mutex::new(HashSet::new()),
            trust_proxy_headers,
        }
    }

    /// `None` unless the instance serves `PROGRAM_KIND=aztec-votes`; the route is then a 404.
    pub fn from_config(config: &Config) -> eyre::Result<Option<Self>> {
        if !config.is_aztec_votes() {
            return Ok(None);
        }
        let program = config
            .e3_program_address
            .parse()
            .map_err(|error| eyre::eyre!("the E3 program address is invalid: {error}"))?;
        Ok(Some(Self::new(
            Arc::new(L1Votes { program }),
            config.trust_proxy_headers,
        )))
    }

    /// Claim `slot` of `e3_id` for an enrollment. `false` when another request holds it.
    fn claim(&self, e3_id: U256, slot: Address) -> bool {
        self.in_flight
            .lock()
            .unwrap_or_else(PoisonError::into_inner)
            .insert((e3_id, slot))
    }

    fn release(&self, e3_id: U256, slots: &[Address]) {
        let mut held = self.in_flight.lock().unwrap_or_else(PoisonError::into_inner);
        for slot in slots {
            held.remove(&(e3_id, *slot));
        }
    }

    /// Filter `slots` against the program and the enrollments in flight, then send one
    /// transaction for the rest.
    async fn run(&self, e3_id: U256, slots: Vec<Address>) -> eyre::Result<EnrollResponse> {
        let states = self.chain.slot_states(e3_id, &slots).await?;

        let mut skipped = Vec::new();
        let mut claimed = Vec::new();
        for (slot, state) in slots.into_iter().zip(states) {
            if state.enrolled {
                skipped.push(Skipped { slot, reason: "enrolled" });
            } else if state.weight.is_zero() {
                skipped.push(Skipped { slot, reason: "no_weight" });
            } else if !self.claim(e3_id, slot) {
                skipped.push(Skipped { slot, reason: "in_flight" });
            } else {
                claimed.push(slot);
            }
        }
        if claimed.is_empty() {
            return Ok(EnrollResponse { tx_hash: None, enrolled: claimed, skipped });
        }

        let sent = self.chain.enroll(e3_id, &claimed).await;
        // Mined or failed, the program (or the next request) decides from here.
        self.release(e3_id, &claimed);
        Ok(EnrollResponse { tx_hash: Some(sent?), enrolled: claimed, skipped })
    }
}

fn parse_request(request: &EnrollRequest) -> Result<(U256, Vec<Address>), String> {
    let e3_id = e3_id_to_u256(&request.round_id).map_err(|error| error.to_string())?;
    if request.slots.is_empty() {
        return Err("Name at least one slot".to_owned());
    }
    if request.slots.len() > MAX_SLOTS {
        return Err(format!("Name at most {MAX_SLOTS} slots"));
    }
    let mut slots: Vec<Address> = Vec::with_capacity(request.slots.len());
    for slot in &request.slots {
        let slot: Address = slot
            .parse()
            .map_err(|_| "A slot is not an address".to_owned())?;
        // A repeated slot is one enrollment.
        if !slots.contains(&slot) {
            slots.push(slot);
        }
    }
    Ok((e3_id, slots))
}

/// Enroll the slots of a voter that the program does not know yet.
pub async fn enroll(
    http: HttpRequest,
    body: web::Json<EnrollRequest>,
    service: Option<web::Data<EnrollService>>,
) -> HttpResponse {
    let Some(service) = service else {
        return HttpResponse::NotFound().finish();
    };
    let caller = identify(&http, service.trust_proxy_headers);
    let request = body.into_inner();
    let (e3_id, slots) = match parse_request(&request) {
        Ok(parsed) => parsed,
        Err(message) => return json_message(StatusCode::BAD_REQUEST, message),
    };
    // The round's window is charged only for requests the caller's own window admits, so one
    // caller cannot use up a round's budget by being refused.
    if service.callers.check_caller(&caller).is_err()
        || service.rounds.check_caller(&e3_id.to_string()).is_err()
    {
        warn!("Rate limit refused an enrollment from {caller}");
        return json_message(
            StatusCode::TOO_MANY_REQUESTS,
            "Too many enrollments, slow down",
        );
    }

    info!("[e3_id={e3_id}] Enrolling {} slots", slots.len());
    match service.run(e3_id, slots).await {
        Ok(response) => HttpResponse::Ok().json(response),
        Err(error) => {
            error!("[e3_id={e3_id}] Could not enroll: {error:#}");
            json_message(
                StatusCode::SERVICE_UNAVAILABLE,
                "The enrollment could not be sent; send enroll from your wallet",
            )
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use actix_web::{test, App};
    use alloy::primitives::address;
    use serde_json::json;
    use std::sync::Mutex as StdMutex;
    use tokio::sync::Notify;

    const A: Address = address!("0x00000000000000000000000000000000000000a1");
    const B: Address = address!("0x00000000000000000000000000000000000000b2");
    const C: Address = address!("0x00000000000000000000000000000000000000c3");

    /// A program where `enrolled` slots are enrolled and `weights` holds the others' weight; a
    /// sent enrollment is recorded, and can be held until `hold` is notified.
    #[derive(Default)]
    struct FakeChain {
        enrolled: Vec<Address>,
        weights: Vec<(Address, u64)>,
        sent: StdMutex<Vec<Vec<Address>>>,
        hold: Option<Arc<Notify>>,
        send_fails: bool,
    }

    #[async_trait]
    impl VotesChain for FakeChain {
        async fn slot_states(&self, _: U256, slots: &[Address]) -> eyre::Result<Vec<SlotState>> {
            Ok(slots
                .iter()
                .map(|slot| SlotState {
                    enrolled: self.enrolled.contains(slot),
                    weight: U256::from(
                        self.weights
                            .iter()
                            .find(|(held, _)| held == slot)
                            .map_or(0, |(_, weight)| *weight),
                    ),
                })
                .collect())
        }

        async fn enroll(&self, _: U256, slots: &[Address]) -> eyre::Result<B256> {
            self.sent.lock().unwrap().push(slots.to_vec());
            if let Some(hold) = &self.hold {
                hold.notified().await;
            }
            eyre::ensure!(!self.send_fails, "the transaction reverted");
            Ok(B256::repeat_byte(0x11))
        }
    }

    fn body(slots: &[Address]) -> serde_json::Value {
        json!({ "round_id": "42", "slots": slots.iter().map(|s| s.to_string()).collect::<Vec<_>>() })
    }

    #[actix_web::test]
    async fn a_server_of_another_kind_has_no_route() {
        let app = test::init_service(App::new().route("/enroll", web::post().to(enroll))).await;
        let response = test::call_service(
            &app,
            test::TestRequest::post().uri("/enroll").set_json(body(&[A])).to_request(),
        )
        .await;
        assert_eq!(response.status(), StatusCode::NOT_FOUND);
    }

    #[actix_web::test]
    async fn only_slots_that_need_it_are_enrolled_in_one_transaction() {
        let chain = Arc::new(FakeChain {
            enrolled: vec![A],
            weights: vec![(A, 5), (B, 7)],
            ..Default::default()
        });
        let service = EnrollService::new(chain.clone(), false);
        let response = service.run(U256::from(42), vec![A, B, C]).await.unwrap();
        assert_eq!(response.enrolled, vec![B]);
        assert_eq!(
            response.skipped,
            vec![
                Skipped { slot: A, reason: "enrolled" },
                Skipped { slot: C, reason: "no_weight" },
            ]
        );
        assert_eq!(response.tx_hash, Some(B256::repeat_byte(0x11)));
        assert_eq!(*chain.sent.lock().unwrap(), vec![vec![B]]);

        // Nothing to enroll: no transaction.
        let none = service.run(U256::from(42), vec![A, C]).await.unwrap();
        assert_eq!(none.tx_hash, None);
        assert_eq!(chain.sent.lock().unwrap().len(), 1);
    }

    #[actix_web::test]
    async fn the_route_answers_the_documented_shape_and_caps_the_slots() {
        let chain = Arc::new(FakeChain { weights: vec![(A, 5)], ..Default::default() });
        let service = web::Data::new(EnrollService::new(chain, false));
        let app = test::init_service(
            App::new()
                .app_data(service)
                .route("/enroll", web::post().to(enroll)),
        )
        .await;

        let ok = test::call_service(
            &app,
            test::TestRequest::post().uri("/enroll").set_json(body(&[A, A, B])).to_request(),
        )
        .await;
        assert_eq!(ok.status(), StatusCode::OK);
        let answer: serde_json::Value = test::read_body_json(ok).await;
        assert_eq!(answer["tx_hash"], json!(B256::repeat_byte(0x11)));
        assert_eq!(answer["enrolled"], json!([A]));
        assert_eq!(answer["skipped"], json!([{ "slot": B, "reason": "no_weight" }]));

        let many: Vec<Address> = (0..=MAX_SLOTS as u64)
            .map(|index| Address::left_padding_from(&index.to_be_bytes()))
            .collect();
        for bad in [
            body(&many),
            body(&[]),
            json!({ "round_id": "42", "slots": ["nope"] }),
            json!({ "round_id": "x", "slots": [A.to_string()] }),
        ] {
            let response = test::call_service(
                &app,
                test::TestRequest::post().uri("/enroll").set_json(bad).to_request(),
            )
            .await;
            assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        }
    }

    #[actix_web::test]
    async fn a_slot_with_an_enrollment_in_flight_is_not_sent_again() {
        let hold = Arc::new(Notify::new());
        let chain = Arc::new(FakeChain {
            weights: vec![(A, 5), (B, 5)],
            hold: Some(hold.clone()),
            ..Default::default()
        });
        let service = Arc::new(EnrollService::new(chain.clone(), false));
        let first = tokio::spawn({
            let service = service.clone();
            async move { service.run(U256::from(42), vec![A]).await }
        });
        while chain.sent.lock().unwrap().is_empty() {
            tokio::task::yield_now().await;
        }

        // A second request for A while the first is unmined sends only B.
        let second = tokio::spawn({
            let service = service.clone();
            async move { service.run(U256::from(42), vec![A, B]).await }
        });
        while chain.sent.lock().unwrap().len() < 2 {
            tokio::task::yield_now().await;
        }
        // `notify_one` stores a permit, so neither held send can miss its release.
        hold.notify_one();
        hold.notify_one();
        let second = second.await.unwrap().unwrap();
        assert_eq!(second.enrolled, vec![B]);
        assert_eq!(second.skipped, vec![Skipped { slot: A, reason: "in_flight" }]);
        first.await.unwrap().unwrap();

        // Mined, the slot is free again (the program would call it enrolled by then).
        assert!(service.claim(U256::from(42), A));
    }

    #[actix_web::test]
    async fn a_failed_send_frees_its_slots() {
        let chain = Arc::new(FakeChain {
            weights: vec![(A, 5)],
            send_fails: true,
            ..Default::default()
        });
        let service = EnrollService::new(chain, false);
        assert!(service.run(U256::from(42), vec![A]).await.is_err());
        assert!(service.claim(U256::from(42), A));
    }

    #[actix_web::test]
    async fn a_failed_send_is_a_503_and_a_caller_is_limited() {
        let chain = Arc::new(FakeChain { weights: vec![(A, 5)], send_fails: true, ..Default::default() });
        let service = web::Data::new(EnrollService::new(chain, false));
        let app = test::init_service(
            App::new()
                .app_data(service)
                .route("/enroll", web::post().to(enroll)),
        )
        .await;
        let call = || {
            test::TestRequest::post()
                .uri("/enroll")
                .peer_addr("203.0.113.7:1".parse().unwrap())
                .set_json(body(&[A]))
                .to_request()
        };
        for _ in 0..PER_CALLER_LIMIT {
            let response = test::call_service(&app, call()).await;
            assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
        }
        let response = test::call_service(&app, call()).await;
        assert_eq!(response.status(), StatusCode::TOO_MANY_REQUESTS);
    }

    #[actix_web::test]
    async fn a_round_has_its_own_budget() {
        let service = web::Data::new(EnrollService::new(Arc::new(FakeChain::default()), false));
        let app = test::init_service(
            App::new()
                .app_data(service)
                .route("/enroll", web::post().to(enroll)),
        )
        .await;
        // Each request comes from another caller, so only the round's window can refuse.
        for index in 0..=PER_ROUND_LIMIT {
            let response = test::call_service(
                &app,
                test::TestRequest::post()
                    .uri("/enroll")
                    .peer_addr(format!("203.0.113.{}:1", index % 250).parse().unwrap())
                    .set_json(body(&[A]))
                    .to_request(),
            )
            .await;
            let expected = if index < PER_ROUND_LIMIT { StatusCode::OK } else { StatusCode::TOO_MANY_REQUESTS };
            assert_eq!(response.status(), expected, "request {index}");
        }
    }
}
