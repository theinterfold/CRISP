// SPDX-License-Identifier: LGPL-3.0-only

//! Rounds whose inputs are accepted on a remote chain (`PROGRAM_KIND=aztec` or `gnosis`).
//!
//! The L1 round of such a program holds no inputs. The remote contract accepts them, and the server
//! learns them from the remote chain's public logs, in the shape the L1 `InputCommitted` handler
//! stores. The L1 program then receives the root of the remote input tree, and its
//! `InputRootSubmitted` event, not a deadline, starts the computation.

use super::*;
use alloy_primitives::B256;
use crisp_remote_input::{readiness, Readiness, RemoteInput, RemoteInputSource};
use crate::server::token_holders::rpc_logs;
use crisp_gnosis_ingest::GnosisInputSource;
use e3_compute_provider::{ComputeInput, FHEInputs, PublishedData};
use e3_user_program::policy::crisp;
use fhe::bfv::BfvParameters;
use serde::{Deserialize, Serialize};
use std::{str::FromStr, time::Instant};

const POLL_INTERVAL: Duration = Duration::from_secs(5);
/// A failed computation is retried no sooner than this. The L1 path retries at fixed offsets from
/// its deadline, and a remote round has none.
const COMPUTE_RETRY_INTERVAL: Duration = Duration::from_secs(60);

/// How often the Interfold stage of a round is read.
const LIVENESS_INTERVAL: Duration = Duration::from_secs(60);

/// Where the ingest of a round resumes, an opaque position of the remote source.
const CURSOR_KEY_PREFIX: &str = "_remote:cursor:";
/// The `InputRootSubmitted` record of a round.
const ROOT_KEY_PREFIX: &str = "_remote:root:";

/// What the L1 program committed to for a round: the root and how many inputs it covers.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct SubmittedRoot {
    input_root: String,
    num_inputs: u64,
}

/// The custom parameters of a remote-program round: `abi.encode(numOptions, credits, minAge,
/// allowMockDocuments, nationalityMode, countries, nationalityCommitment)`. The L1 program
/// validates all of it, and the remote contract enforces the age, the documents and the
/// nationality rule. The server reads the number of options and the credits.
type RemoteCustomParams = (
    sol_data::Uint<256>,
    sol_data::Uint<256>,
    sol_data::Uint<256>,
    sol_data::Bool,
    sol_data::Uint<8>,
    sol_data::Array<sol_data::String>,
    sol_data::Uint<256>,
);

fn round_params(custom_params: &[u8]) -> eyre::Result<CustomParams> {
    // `abi.encode` of the words, not of one tuple: no offset word leads the data.
    let (num_options, credits, ..) =
        <RemoteCustomParams as SolType>::abi_decode_params(custom_params)
            .context("Failed to decode custom params from E3 event")?;
    Ok(CustomParams {
        // There is no token: the voter's credits are the same constant for everyone, and the
        // eligibility is proved on the remote chain.
        token_address: Address::ZERO.to_string(),
        balance_threshold: "0".to_string(),
        num_options: num_options.to_string(),
        credit_mode: CreditMode::Constant,
        credits: Some(credits.to_string()),
        // The server holds no census. `Onchain` is the mode whose electorate the server does not
        // list or prove, and no census is discovered or published for a remote round.
        census_mode: CensusMode::Onchain,
        voting_power_divisor: "0".to_string(),
    })
}

/// The custom parameters of a votes round (`PROGRAM_KIND=aztec-votes`) are `CRISPProgram`'s seven
/// flat words: `abi.encode(token, minVotingPower, numOptions, creditMode, credits, censusMode,
/// requestedDivisor)`. The L1 program accepts only CUSTOM credits with the ONCHAIN census.
type VotesCustomParams = (
    sol_data::Address,
    sol_data::Uint<256>,
    sol_data::Uint<256>,
    sol_data::Uint<256>,
    sol_data::Uint<256>,
    sol_data::Uint<256>,
    sol_data::Uint<256>,
);

fn votes_round_params(custom_params: &[u8]) -> eyre::Result<CustomParams> {
    let (token, min_voting_power, num_options, _, _, _, divisor) =
        <VotesCustomParams as SolType>::abi_decode_params(custom_params)
            .context("Failed to decode custom params from E3 event")?;
    Ok(CustomParams {
        token_address: token.to_string(),
        balance_threshold: min_voting_power.to_string(),
        num_options: num_options.to_string(),
        // The program weighs a ballot by the slot's voting power over the round's divisor, and
        // reads each slot's power itself: the server lists nobody as the electorate.
        credit_mode: CreditMode::Custom,
        credits: None,
        census_mode: CensusMode::Onchain,
        voting_power_divisor: divisor.to_string(),
    })
}

/// The custom parameters of a Gnosis round: `abi.encode(censusMode, censusRoot, censusTotal,
/// proposalHash, metadataCid)`, five flat words with no leading offset. The L1 program validates
/// them and the voting contract enforces them; the server reads nothing from them.
type GnosisCustomParams = (
    sol_data::Uint<8>,
    sol_data::FixedBytes<32>,
    sol_data::Uint<256>,
    sol_data::FixedBytes<32>,
    sol_data::String,
);

/// The three options of a Gnosis ballot: For, Against, Abstain.
const GNOSIS_NUM_OPTIONS: &str = "3";

/// The widest `eth_getLogs` range of holder discovery when `INDEX_CHUNK_SIZE` is not set.
const GNOSIS_LOG_CHUNK_SIZE: u64 = 10_000;

fn gnosis_round_params(custom_params: &[u8], token: Address) -> eyre::Result<CustomParams> {
    <GnosisCustomParams as SolType>::abi_decode_params(custom_params)
        .context("Failed to decode custom params from E3 event")?;
    Ok(CustomParams {
        token_address: token.to_string(),
        balance_threshold: "0".to_string(),
        num_options: GNOSIS_NUM_OPTIONS.to_string(),
        // The contract weighs a ballot by the slot's voting power over the round's divisor.
        credit_mode: CreditMode::Custom,
        credits: None,
        // The contract reads each slot's power itself, so the server lists nobody as the
        // electorate: the holders it discovers are mask targets.
        census_mode: CensusMode::Onchain,
        voting_power_divisor: "0".to_string(),
    })
}

/// Record a round requested for the remote program.
pub(super) async fn handle_e3_requested<S: DataStore>(
    event: E3Requested,
    ctx: Arc<IndexerContext<S, ReadWrite>>,
) -> eyre::Result<()> {
    let e3_id = event.e3Id.to_string();
    let store = ctx.store();
    let mut repo = CrispE3Repository::new(store.clone(), &e3_id);
    let contract = ctx.contract();

    // 0xcd6f4a4f = E3DoesNotExist()
    let e3 = call_with_retry_attempts("get_e3", &["0xcd6f4a4f"], E3_VISIBLE_ATTEMPTS, || async {
        within(READ_TIMEOUT, contract.get_e3(event.e3Id))
            .await
            .map_err(|error| anyhow::anyhow!("{error:#}"))
    })
    .await
    .map_err(report)?;

    let gnosis = CONFIG.is_gnosis();
    let custom_params = if gnosis {
        gnosis_round_params(&event.e3.customParams, CONFIG.gnosis_token()?)?
    } else if CONFIG.is_aztec_votes() {
        votes_round_params(&event.e3.customParams)?
    } else {
        round_params(&event.e3.customParams)?
    };
    let input_deadline = e3.inputWindow[1].saturating_to::<u64>();
    let request_time = event.e3.requestBlock.saturating_to::<u64>();

    repo.initialize_round(
        custom_params,
        event.e3.e3Program,
        e3.requester.to_string(),
        input_deadline,
        input_deadline,
        // A Gnosis round's snapshot is the one the voting contract stores, which it clamps to its
        // own clock: it is read with the round (`discover_gnosis_holders`).
        if gnosis {
            UNKNOWN_SNAPSHOT
        } else {
            request_time.saturating_sub(1)
        },
    )
    .await?;
    if gnosis {
        repo.set_discovery_pending(true).await?;
    }
    CurrentRoundRepository::new(store)
        .record_round(&e3_id)
        .await?;

    // The committee key may have been indexed while this handler ran.
    activate_round_if_ready(&e3_id, &ctx).await?;
    Ok(())
}

/// Record the input root of a round and compute it if every input is already indexed.
pub(super) async fn handle_input_root_submitted<S: DataStore>(
    event: InputRootSubmitted,
    ctx: Arc<IndexerContext<S, ReadWrite>>,
) -> eyre::Result<()> {
    let e3_id = event.e3Id.to_string();
    let num_inputs = u64::try_from(event.numInputs).map_err(|_| {
        eyre!(
            "[e3_id={e3_id}] numInputs {} does not fit in u64",
            event.numInputs
        )
    })?;
    info!(
        "[e3_id={e3_id}] InputRootSubmitted: root {} over {num_inputs} input(s)",
        event.inputRoot
    );
    let store = ctx.store();
    record_input_root(
        store.clone(),
        &e3_id,
        &SubmittedRoot {
            input_root: event.inputRoot.to_string(),
            num_inputs,
        },
    )
    .await?;
    compute_if_ready(&e3_id, store).await
}

async fn record_input_root<S: DataStore>(
    mut store: SharedStore<S>,
    e3_id: &str,
    root: &SubmittedRoot,
) -> eyre::Result<()> {
    let key = format!("{ROOT_KEY_PREFIX}{e3_id}");
    store
        .insert(&key, root)
        .await
        .map_err(|error| eyre!("Could not store the input root at '{key}': {error}"))
}

async fn submitted_root<S: DataStore>(
    store: &SharedStore<S>,
    e3_id: &str,
) -> eyre::Result<Option<SubmittedRoot>> {
    let key = format!("{ROOT_KEY_PREFIX}{e3_id}");
    store
        .get(&key)
        .await
        .map_err(|error| eyre!("Could not read the input root at '{key}': {error}"))
}

/// What the indexed inputs of a round say about computing it.
#[derive(Debug, PartialEq, Eq)]
enum ComputeGate {
    /// The round has no recorded root, is not waiting for computation, or lacks inputs.
    NotYet,
    Go,
}

/// Decide from the root record and the indexed count. An index that holds more inputs than the root
/// counts is an error: waiting does not repair it.
fn compute_gate(
    root: Option<&SubmittedRoot>,
    status: &str,
    indexed: usize,
) -> eyre::Result<ComputeGate> {
    let Some(root) = root else {
        return Ok(ComputeGate::NotYet);
    };
    if !matches!(status, ACTIVE | EXPIRED) {
        return Ok(ComputeGate::NotYet);
    }
    match readiness(indexed, root.num_inputs) {
        Readiness::Ready => Ok(ComputeGate::Go),
        Readiness::Waiting { .. } => Ok(ComputeGate::NotYet),
        Readiness::Inconsistent { indexed, expected } => bail!(
            "the index holds {indexed} input(s), but the L1 root covers {expected}; refusing to \
             compute while the counts differ"
        ),
    }
}

/// The root of the input tree over `snapshot`, built as the Secure Process builds it: a leaf per
/// input, `sha256(keccak256(ciphertext) || commitment || slot || parent) mod p`, in a zk-kit lazy
/// IMT with circom Poseidon and a depth that follows the leaf count. It is the root `CRISPProgram`
/// accumulates, and the one the remote contract closes the round with.
fn rebuild_input_root(e3_params: &[u8], snapshot: &InputSnapshot) -> eyre::Result<U256> {
    let published = snapshot
        .slots
        .iter()
        .zip(&snapshot.parents)
        .zip(&snapshot.commitments)
        .map(|((slot, parent), commitment)| {
            eyre::ensure!(
                *parent < 1 << 40,
                "parent index {parent} is wider than 40 bits"
            );
            // `abi.encodePacked(address, uint40)`, the metadata `CRISPProgram` publishes.
            let mut metadata = slot.to_vec();
            metadata.extend_from_slice(&parent.to_be_bytes()[3..]);
            Ok(PublishedData {
                commitment: Some(*commitment),
                metadata,
            })
        })
        .collect::<eyre::Result<Vec<_>>>()?;
    // The Secure Process also commits to the output ciphertext, so the processor is the program's
    // own: any other would have to build a valid ciphertext too. The root itself comes from the
    // published inputs alone.
    let result = ComputeInput {
        fhe_inputs: FHEInputs {
            ciphertexts: snapshot.ciphertexts.clone(),
            params: e3_params.to_vec(),
        },
        published,
    }
    .process(e3_user_program::fhe_processor, crisp())
    .map_err(|error| eyre!("could not rebuild the input root: {error}"))?;
    eyre::ensure!(
        result.merkle_root.len() <= 32,
        "the rebuilt input root is wider than a word"
    );
    Ok(U256::from_be_slice(&result.merkle_root))
}

/// Refuse a snapshot whose tree is not the one `root` closed, and hand the snapshot back. A round
/// with no input has no tree.
async fn verify_input_root(
    e3_params: Vec<u8>,
    snapshot: InputSnapshot,
    root: &SubmittedRoot,
) -> eyre::Result<InputSnapshot> {
    if snapshot.ciphertexts.is_empty() {
        return Ok(snapshot);
    }
    let expected = U256::from_str(&root.input_root).map_err(|error| {
        eyre!(
            "the stored input root {} is invalid: {error}",
            root.input_root
        )
    })?;
    // Hashing every leaf and recomputing every commitment is CPU work over the whole round.
    let (rebuilt, snapshot) = tokio::task::spawn_blocking(move || {
        rebuild_input_root(&e3_params, &snapshot).map(|rebuilt| (rebuilt, snapshot))
    })
    .await
    .map_err(|error| eyre!("the input root rebuild did not finish: {error}"))??;
    eyre::ensure!(
        rebuilt == expected,
        "the indexed inputs build input root {rebuilt}, but L1 holds {expected}; refusing to \
         compute a round whose inputs are not the ones the remote chain closed"
    );
    Ok(snapshot)
}

/// Compute a round once the L1 program has the root of its inputs and the server holds every one.
///
/// The L1 contract is the authority on the count, as in the deadline pass: starting short would
/// tally a subset and derive a root the contract rejects.
async fn compute_if_ready<S: DataStore>(e3_id: &str, store: SharedStore<S>) -> eyre::Result<()> {
    let root = submitted_root(&store, e3_id).await?;
    let mut repo = CrispE3Repository::new(store, e3_id);
    let Some(round) = repo.try_get_crisp().await? else {
        return Ok(());
    };
    // The record is a cheap count; the snapshot below reads every ciphertext.
    if compute_gate(root.as_ref(), &round.status, round.input_commitments.len())?
        == ComputeGate::NotYet
    {
        return Ok(());
    }
    let snapshot = repo.get_input_snapshot().await?;
    let root = root.expect("a gate that passes has a root");
    if compute_gate(Some(&root), &round.status, snapshot.ciphertexts.len())? == ComputeGate::NotYet
    {
        return Ok(());
    }

    // The inputs are the ones the root commits to, not merely as many. A reorg of the remote chain
    // or a wrong ciphertext would otherwise cost a full compute and an L1 `verify` revert.
    let e3 = repo.get_e3().await?;
    let snapshot = verify_input_root(e3.e3_params.clone(), snapshot, &root).await?;

    // Atomic, like the deadline pass: only one of the handler and the poller proceeds, and a
    // round that already moved on is left alone.
    if !repo.try_mark_expired().await? {
        return Ok(());
    }
    let voter_count = repo.get_vote_count().await?;
    compute_snapshot(&mut repo, e3_id, e3, voter_count, snapshot).await
}

/// What one ingest pass of a round did.
#[derive(Debug, Default, PartialEq, Eq)]
struct Ingested {
    stored: usize,
    /// The first input the server cannot store because it holds no bytes for it.
    missing: Option<(u64, B256)>,
}

/// Store the inputs the remote chain accepted for a round, with the bytes this server staged.
///
/// An input whose bytes the server does not hold stops the pass: the cursor stays before it, so
/// the next pass retries once the bytes are staged. An input the voter committed through another
/// server's attestation cannot be stored here, and the round cannot be computed without it.
async fn ingest_inputs<S, F>(
    mut store: SharedStore<S>,
    e3_id: &str,
    params: &BfvParameters,
    source: &dyn RemoteInputSource,
    staged: F,
) -> eyre::Result<Ingested>
where
    S: DataStore,
    F: Fn(&RemoteInput) -> eyre::Result<Option<Vec<u8>>>,
{
    let e3_value = e3_id_to_u256(e3_id).map_err(report)?;
    let cursor_key = format!("{CURSOR_KEY_PREFIX}{e3_id}");
    let mut cursor: Option<String> = store
        .get(&cursor_key)
        .await
        .map_err(|error| eyre!("Could not read the ingest cursor at '{cursor_key}': {error}"))?;
    let mut repo = CrispE3Repository::new(store.clone(), e3_id);
    let mut outcome = Ingested::default();

    loop {
        let page = source.fetch_inputs(e3_value, cursor.as_deref()).await?;
        let mut last_stored: Option<&str> = None;
        for input in &page.inputs {
            let Some(ciphertext) = staged(input)? else {
                outcome.missing = Some((input.index, input.ciphertext_hash));
                break;
            };
            repo.insert_ciphertext_input(
                ciphertext,
                input.index,
                input.commitment.0,
                input.slot.into(),
                input.parent_index_plus_one,
                params,
            )
            .await?;
            outcome.stored += 1;
            last_stored = Some(&input.cursor);
        }

        // Past the page only when every input of it is stored; otherwise past the last stored one.
        let resume = if outcome.missing.is_some() {
            last_stored.map(str::to_owned)
        } else {
            page.scanned_to.clone()
        };
        if let Some(resume) = resume {
            store
                .insert(&cursor_key, &resume)
                .await
                .map_err(|error| eyre!("Could not store the ingest cursor: {error}"))?;
            cursor = Some(resume);
        }
        if outcome.missing.is_some() || !page.more {
            return Ok(outcome);
        }
    }
}

async fn ingest_round<S: DataStore>(
    e3_id: &str,
    store: SharedStore<S>,
    availability: &AvailabilityService,
    source: &dyn RemoteInputSource,
) -> eyre::Result<Ingested> {
    let e3_value = e3_id_to_u256(e3_id).map_err(report)?;
    let e3 = CrispE3Repository::new(store.clone(), e3_id)
        .get_e3()
        .await?;
    let params = decode_bfv_params_arc(&e3.e3_params)?;
    ingest_inputs(store, e3_id, &params, source, |input| {
        availability
            .remote_object(e3_value, input.ciphertext_hash)
            .map_err(report)
    })
    .await
}

/// Whether the Interfold stage ends the round's inputs, or the compute deadline passed with no
/// output published. The remote inputs and their staged bytes serve nobody after that.
///
/// Interfold sets `computeDeadline` when the committee key is published, so it reads zero while the
/// round is still being set up: that is not a deadline that has passed.
fn is_over(stage: &E3Stage, compute_deadline: u64, now: u64) -> bool {
    stage_ends_input_retrieval(stage)
        || (compute_deadline != 0
            && now >= compute_deadline
            && !matches!(stage, E3Stage::CiphertextReady | E3Stage::Complete))
}

async fn round_is_over(interfold: &InterfoldContract<ReadOnly>, e3_id: &str) -> eyre::Result<bool> {
    let e3_id = e3_id_to_u256(e3_id).map_err(report)?;
    let stage = within(READ_TIMEOUT, interfold.get_e3_stage(e3_id)).await?;
    if stage_ends_input_retrieval(&stage) {
        return Ok(true);
    }
    let deadlines = within(READ_TIMEOUT, interfold.get_deadlines(e3_id)).await?;
    let now = rpc::latest_timestamp(rpc::provider().await?).await?;
    Ok(is_over(
        &stage,
        deadlines.computeDeadline.saturating_to::<u64>(),
        now,
    ))
}

/// How often a round that still owes its holder discovery is tried again.
const DISCOVERY_RETRY_INTERVAL: Duration = Duration::from_secs(30);

/// Discover the holders a Gnosis round draws mask targets from, once the voting contract holds the
/// round: the delegates of the token whose votes at the round's snapshot carry weight. Returns
/// without a result while the ROUND message has not reached the contract. The electorate is not
/// this list: the contract reads each slot's power itself, so a failure costs only mask cover.
async fn discover_gnosis_holders<S: DataStore>(
    e3_id: &str,
    store: SharedStore<S>,
    voting: &GnosisInputSource,
) -> eyre::Result<()> {
    let mut repo = CrispE3Repository::new(store, e3_id);
    let round = repo.get_crisp().await?;
    if !round.discovery_pending {
        return Ok(());
    }
    let Some(onchain) = voting.round(e3_id_to_u256(e3_id).map_err(report)?).await? else {
        return Ok(());
    };
    let threshold = voting.min_voting_power().await?.max(onchain.divisor);
    let mut holders = rpc_logs::get_token_holders_with_voting_power(
        rpc::http_provider(&CONFIG.gnosis_rpc_url)?,
        CONFIG.gnosis_token()?,
        CONFIG.gnosis_token_start(),
        CONFIG.index_chunk_size.unwrap_or(GNOSIS_LOG_CHUNK_SIZE),
        onchain.snapshot,
        threshold,
        onchain.divisor,
    )
    .await?;
    order_token_holders(&mut holders);
    info!(
        "[e3_id={e3_id}] Found {} mask target(s) at snapshot {}",
        holders.len(),
        onchain.snapshot
    );
    repo.set_snapshot_block(onchain.snapshot).await?;
    repo.set_eligible_addresses(holders).await?;
    repo.set_discovery_pending(false).await
}

/// Ingest the inputs of every unfinished remote round and compute those whose root has arrived.
///
/// Polls: the remote chain is read over HTTP, so there is no event to wait on.
pub(super) async fn run_ingest<S: DataStore>(
    store: SharedStore<S>,
    availability: Arc<AvailabilityService>,
) -> eyre::Result<()> {
    let source = availability
        .remote_source()
        .ok_or_else(|| eyre!("PROGRAM_KIND has no remote input source"))?;
    let gnosis = availability.gnosis_source();
    // A round that is over is not read again until a restart.
    let mut done = std::collections::HashSet::<String>::new();
    let mut last_compute = HashMap::<String, Instant>::new();
    let mut reported_missing = HashMap::<String, (u64, B256)>::new();
    let mut last_liveness = HashMap::<String, Instant>::new();
    let mut last_discovery = HashMap::<String, Instant>::new();
    let interfold =
        InterfoldContractFactory::create_read(&CONFIG.http_rpc_url, &CONFIG.interfold_address)
            .await?;

    loop {
        for e3_id in CurrentRoundRepository::new(store.clone())
            .get_round_ids()
            .await?
        {
            if done.contains(&e3_id) {
                continue;
            }
            let status = match CrispE3Repository::new(store.clone(), &e3_id)
                .get_status()
                .await
            {
                Ok(status) => status,
                Err(error) => {
                    warn!("[e3_id={e3_id}] Could not read the round: {error:#}");
                    continue;
                }
            };
            if matches!(status.as_str(), CIPHERTEXT_PUBLISHED | FINISHED) {
                release_staged(&e3_id, &availability);
                done.insert(e3_id);
                continue;
            }
            // A failed E3 never reaches a final local status, so the chain decides when its inputs
            // are no longer needed. Read at a slower pace than the remote chain.
            if last_liveness
                .get(&e3_id)
                .is_none_or(|at| at.elapsed() >= LIVENESS_INTERVAL)
            {
                last_liveness.insert(e3_id.clone(), Instant::now());
                match round_is_over(&interfold, &e3_id).await {
                    Ok(true) => {
                        info!(
                            "[e3_id={e3_id}] The round failed or can no longer produce an output"
                        );
                        release_staged(&e3_id, &availability);
                        done.insert(e3_id);
                        continue;
                    }
                    Ok(false) => {}
                    Err(error) => {
                        warn!("[e3_id={e3_id}] Could not read the round stage: {error:#}")
                    }
                }
            }
            if let Some(voting) = &gnosis {
                if matches!(status.as_str(), REQUESTED | ACTIVE)
                    && last_discovery
                        .get(&e3_id)
                        .is_none_or(|at| at.elapsed() >= DISCOVERY_RETRY_INTERVAL)
                {
                    last_discovery.insert(e3_id.clone(), Instant::now());
                    if let Err(error) =
                        discover_gnosis_holders(&e3_id, store.clone(), voting).await
                    {
                        warn!("[e3_id={e3_id}] Holder discovery failed, will retry: {error:#}");
                    }
                }
            }
            if !matches!(status.as_str(), ACTIVE | EXPIRED) {
                continue;
            }

            match ingest_round(&e3_id, store.clone(), &availability, source.as_ref()).await {
                Ok(Ingested { stored, missing }) => {
                    if stored > 0 {
                        info!("[e3_id={e3_id}] Ingested {stored} remote input(s)");
                    }
                    match missing {
                        Some(missing) if reported_missing.get(&e3_id) != Some(&missing) => {
                            warn!(
                                "[e3_id={e3_id}] Remote input {} (ciphertext {}) was accepted \
                                 without bytes staged on this server; the round cannot be \
                                 computed until they are staged",
                                missing.0, missing.1
                            );
                            reported_missing.insert(e3_id.clone(), missing);
                        }
                        Some(_) => {}
                        None => {
                            reported_missing.remove(&e3_id);
                        }
                    }
                }
                Err(error) => {
                    warn!("[e3_id={e3_id}] Could not ingest remote inputs: {error:#}");
                    continue;
                }
            }

            if last_compute
                .get(&e3_id)
                .is_some_and(|at| at.elapsed() < COMPUTE_RETRY_INTERVAL)
            {
                continue;
            }
            if let Err(error) = compute_if_ready(&e3_id, store.clone()).await {
                error!("[e3_id={e3_id}] Could not compute the round: {error:#}");
                last_compute.insert(e3_id, Instant::now());
            }
        }
        sleep(POLL_INTERVAL).await;
    }
}

/// The staged bytes of a finished round are no longer needed.
fn release_staged(e3_id: &str, availability: &AvailabilityService) {
    let Ok(e3_value) = e3_id_to_u256(e3_id) else {
        return;
    };
    match availability.release_remote_objects(e3_value) {
        Ok(0) => {}
        Ok(released) => info!("[e3_id={e3_id}] Released {released} staged input(s)"),
        Err(error) => warn!("[e3_id={e3_id}] Could not release staged inputs: {error:#}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::models::test_custom_params;
    use alloy::primitives::keccak256;
    use alloy::sol_types::SolValue;
    use async_trait::async_trait;
    use crisp_remote_input::{CensusRootPage, InputPage};
    use e3_fhe_params::{build_bfv_params_from_set_arc, BfvParamSet, BfvPreset};
    use e3_sdk::indexer::InMemoryStore;
    use std::sync::Mutex;
    use tokio::sync::RwLock;

    fn bfv() -> Arc<BfvParameters> {
        build_bfv_params_from_set_arc(BfvParamSet::from(BfvPreset::InsecureThreshold64))
    }

    fn store() -> SharedStore<InMemoryStore> {
        SharedStore::new(Arc::new(RwLock::new(InMemoryStore::new())))
    }

    fn root(num_inputs: u64) -> SubmittedRoot {
        SubmittedRoot {
            input_root: "7".to_string(),
            num_inputs,
        }
    }

    #[test]
    fn custom_params_of_a_remote_round_come_from_its_seven_words() {
        let encoded = <RemoteCustomParams as SolType>::abi_encode_params(&(
            U256::from(4),
            U256::from(10),
            U256::from(18),
            true,
            1u8,
            vec!["DEU".to_string(), "FRA".to_string()],
            U256::ZERO,
        ));

        let params = round_params(&encoded).unwrap();

        assert_eq!(params.num_options, "4");
        assert_eq!(params.credits.as_deref(), Some("10"));
        assert_eq!(params.credit_mode, CreditMode::Constant);
        assert_eq!(params.census_mode, CensusMode::Onchain);
        assert_eq!(params.token_address, Address::ZERO.to_string());

        // Rules do not change what the server reads: a round with none decodes the same.
        let plain = <RemoteCustomParams as SolType>::abi_encode_params(&(
            U256::from(4),
            U256::from(10),
            U256::from(18),
            true,
            0u8,
            Vec::<String>::new(),
            U256::ZERO,
        ));
        assert_eq!(round_params(&plain).unwrap().num_options, "4");

        // The earlier four-word layout is not this layout.
        let old = (U256::from(4), U256::from(10), U256::from(18), true).abi_encode_params();
        assert!(round_params(&old).is_err());
        assert!(round_params(&[0u8; 31]).is_err());
    }

    #[test]
    fn custom_params_of_a_votes_round_are_the_seven_words_of_the_l1_program() {
        let token = Address::repeat_byte(0x77);
        let encoded = <VotesCustomParams as SolType>::abi_encode_params(&(
            token,
            U256::from(1_000),
            U256::from(3),
            U256::from(1),
            U256::ZERO,
            U256::from(2),
            U256::from(7),
        ));

        let params = votes_round_params(&encoded).unwrap();

        assert_eq!(params.token_address, token.to_string());
        assert_eq!(params.balance_threshold, "1000");
        assert_eq!(params.num_options, "3");
        assert_eq!(params.credit_mode, CreditMode::Custom);
        assert_eq!(params.credits, None);
        assert_eq!(params.census_mode, CensusMode::Onchain);
        assert_eq!(params.voting_power_divisor, "7");
        // The ZKPassport decoder, which a votes server ran by mistake, refuses this layout.
        assert!(round_params(&encoded).is_err());
        assert!(votes_round_params(&encoded[..encoded.len() - 1]).is_err());
    }

    #[test]
    fn custom_params_of_a_gnosis_round_come_from_its_five_flat_words() {
        let token = Address::repeat_byte(0x77);
        let encoded = <GnosisCustomParams as SolType>::abi_encode_params(&(
            2u8,
            B256::repeat_byte(0x11),
            U256::from(12),
            B256::repeat_byte(0x22),
            "bafy-metadata".to_string(),
        ));

        let params = gnosis_round_params(&encoded, token).unwrap();

        assert_eq!(params.token_address, token.to_string());
        assert_eq!(params.num_options, "3");
        assert_eq!(params.credit_mode, CreditMode::Custom);
        assert_eq!(params.credits, None);
        assert_eq!(params.census_mode, CensusMode::Onchain);
        assert_eq!(params.balance_threshold, "0");

        // The data of another layout, or none, is not a Gnosis round.
        assert!(gnosis_round_params(&encoded[..encoded.len() - 33], token).is_err());
        assert!(gnosis_round_params(&[0u8; 31], token).is_err());
    }

    #[test]
    fn compute_waits_for_the_root_a_live_round_and_every_input() {
        assert_eq!(compute_gate(None, ACTIVE, 3).unwrap(), ComputeGate::NotYet);
        assert_eq!(
            compute_gate(Some(&root(3)), ACTIVE, 2).unwrap(),
            ComputeGate::NotYet
        );
        assert_eq!(
            compute_gate(Some(&root(3)), ACTIVE, 3).unwrap(),
            ComputeGate::Go
        );
        assert_eq!(
            compute_gate(Some(&root(3)), EXPIRED, 3).unwrap(),
            ComputeGate::Go
        );
        // A round that is computing, or done, is not computed again.
        for status in [
            REQUESTED,
            COMPUTING,
            PUBLISHING_CIPHERTEXT,
            CIPHERTEXT_PUBLISHED,
            FINISHED,
        ] {
            assert_eq!(
                compute_gate(Some(&root(3)), status, 3).unwrap(),
                ComputeGate::NotYet,
                "{status}"
            );
        }
    }

    #[test]
    fn an_index_with_more_inputs_than_the_root_is_an_error() {
        assert!(compute_gate(Some(&root(2)), ACTIVE, 3).is_err());
    }

    #[tokio::test]
    async fn the_input_root_is_stored_per_round() {
        let store = store();

        record_input_root(store.clone(), "1", &root(2))
            .await
            .unwrap();

        assert_eq!(submitted_root(&store, "1").await.unwrap(), Some(root(2)));
        assert_eq!(submitted_root(&store, "2").await.unwrap(), None);
    }

    /// Serves `inputs` in pages of `page_size`, resuming after a cursor like the Aztec source: the
    /// cursor of an input is its index, and a page reports the position it scanned to.
    struct Pages {
        inputs: Vec<RemoteInput>,
        page_size: usize,
        requested_after: Mutex<Vec<Option<String>>>,
    }

    impl Pages {
        fn new(count: u64, page_size: usize) -> Self {
            let inputs = (0..count)
                .map(|index| RemoteInput {
                    e3_id: U256::from(1),
                    index,
                    slot: Address::repeat_byte(index as u8 + 1),
                    commitment: B256::repeat_byte(index as u8 + 1),
                    ciphertext_hash: keccak256(bytes_of(index)),
                    parent_index_plus_one: 0,
                    cursor: index.to_string(),
                })
                .collect();
            Self {
                inputs,
                page_size,
                requested_after: Mutex::new(Vec::new()),
            }
        }
    }

    fn bytes_of(index: u64) -> Vec<u8> {
        vec![index as u8 + 1; 3]
    }

    #[async_trait]
    impl RemoteInputSource for Pages {
        async fn fetch_inputs(&self, _e3_id: U256, after: Option<&str>) -> eyre::Result<InputPage> {
            self.requested_after
                .lock()
                .unwrap()
                .push(after.map(str::to_owned));
            let start = after.map_or(0, |after| after.parse::<usize>().unwrap() + 1);
            let page: Vec<_> = self
                .inputs
                .iter()
                .skip(start)
                .take(self.page_size)
                .cloned()
                .collect();
            Ok(InputPage {
                scanned_to: page.last().map(|input| input.cursor.clone()),
                more: page.len() == self.page_size,
                inputs: page,
            })
        }

        async fn census_roots(
            &self,
            _e3_id: U256,
            _after: Option<&str>,
            _proven_only: bool,
        ) -> eyre::Result<CensusRootPage> {
            Ok(CensusRootPage::default())
        }

        async fn latest_timestamp(&self) -> eyre::Result<u64> {
            Ok(0)
        }
    }

    async fn round(store: &SharedStore<InMemoryStore>) -> CrispE3Repository<InMemoryStore> {
        let mut repo = CrispE3Repository::new(store.clone(), "1");
        repo.initialize_round(
            test_custom_params(),
            Address::repeat_byte(0x11),
            "requester".to_string(),
            100,
            100,
            1,
        )
        .await
        .unwrap();
        repo
    }

    fn staged_all(input: &RemoteInput) -> eyre::Result<Option<Vec<u8>>> {
        Ok(Some(bytes_of(input.index)))
    }

    #[tokio::test]
    async fn every_page_of_inputs_is_stored_with_its_staged_bytes() {
        let store = store();
        let repo = round(&store).await;
        let source = Pages::new(5, 2);

        let outcome = ingest_inputs(store.clone(), "1", &bfv(), &source, staged_all)
            .await
            .unwrap();

        assert_eq!(
            outcome,
            Ingested {
                stored: 5,
                missing: None
            }
        );
        let snapshot = repo.get_input_snapshot().await.unwrap();
        assert_eq!(
            snapshot.ciphertexts,
            (0..5)
                .map(|index| (bytes_of(index), index))
                .collect::<Vec<_>>()
        );
        assert_eq!(snapshot.commitments[3], [4u8; 32]);
        assert_eq!(snapshot.slots[3], [4u8; 20]);
        // 5 inputs in pages of 2: a third page, short, ends the pass.
        assert_eq!(source.requested_after.lock().unwrap().len(), 3);
    }

    #[tokio::test]
    async fn a_later_pass_resumes_after_what_it_stored() {
        let store = store();
        round(&store).await;
        let source = Pages::new(3, 20);
        ingest_inputs(store.clone(), "1", &bfv(), &source, staged_all)
            .await
            .unwrap();
        source.requested_after.lock().unwrap().clear();

        let outcome = ingest_inputs(store.clone(), "1", &bfv(), &source, staged_all)
            .await
            .unwrap();

        assert_eq!(outcome.stored, 0);
        assert_eq!(
            *source.requested_after.lock().unwrap(),
            vec![Some("2".to_string())]
        );
    }

    #[tokio::test]
    async fn an_input_without_staged_bytes_stops_the_pass_and_is_retried() {
        let store = store();
        let repo = round(&store).await;
        let source = Pages::new(4, 20);
        let hole = source.inputs[2].ciphertext_hash;
        let without_third = move |input: &RemoteInput| {
            Ok((input.ciphertext_hash != hole).then(|| bytes_of(input.index)))
        };

        let outcome = ingest_inputs(store.clone(), "1", &bfv(), &source, without_third)
            .await
            .unwrap();

        assert_eq!(
            outcome,
            Ingested {
                stored: 2,
                missing: Some((2, hole))
            }
        );
        assert_eq!(
            repo.get_input_snapshot().await.unwrap().ciphertexts.len(),
            2
        );

        // Once the bytes are staged the next pass stores the rest, from the cursor.
        source.requested_after.lock().unwrap().clear();
        let outcome = ingest_inputs(store.clone(), "1", &bfv(), &source, staged_all)
            .await
            .unwrap();
        assert_eq!(
            outcome,
            Ingested {
                stored: 2,
                missing: None
            }
        );
        assert_eq!(
            *source.requested_after.lock().unwrap(),
            vec![Some("1".to_string())]
        );
        assert_eq!(
            repo.get_input_snapshot().await.unwrap().ciphertexts.len(),
            4
        );
    }

    /// The count the gate reads from the round record is the count of the snapshot it computes.
    #[tokio::test]
    async fn the_record_count_matches_the_snapshot() {
        let store = store();
        let repo = round(&store).await;
        ingest_inputs(store.clone(), "1", &bfv(), &Pages::new(3, 20), staged_all)
            .await
            .unwrap();

        let record = repo.get_crisp().await.unwrap();
        let snapshot = repo.get_input_snapshot().await.unwrap();

        assert_eq!(record.input_commitments.len(), snapshot.ciphertexts.len());
        assert_eq!(
            compute_gate(
                Some(&root(3)),
                &record.status,
                record.input_commitments.len()
            )
            .unwrap(),
            ComputeGate::NotYet,
            "a round that is not started is not computed"
        );
    }

    const SINGLE_INPUT_TREE: &str =
        include_str!("../../../../packages/crisp-contracts/tests/fixtures/input-tree.json");
    const THREE_INPUT_TREE: &str =
        include_str!("../../../../packages/crisp-contracts/tests/fixtures/input-tree-append.json");

    fn unhex(value: &serde_json::Value) -> Vec<u8> {
        hex::decode(value.as_str().unwrap().trim_start_matches("0x")).unwrap()
    }

    /// The inputs of a tree that a real `CRISPProgram` built, as a snapshot, with the root it
    /// produced.
    fn contract_tree(fixture: &str) -> (Vec<u8>, InputSnapshot, SubmittedRoot) {
        let fixture: serde_json::Value = serde_json::from_str(fixture).unwrap();
        let mut snapshot = InputSnapshot {
            ciphertexts: vec![],
            commitments: vec![],
            slots: vec![],
            parents: vec![],
            usable: vec![],
        };
        for (index, entry) in fixture["inputs"].as_array().unwrap().iter().enumerate() {
            snapshot
                .ciphertexts
                .push((unhex(&entry["encryptedVote"]), index as u64));
            snapshot
                .commitments
                .push(unhex(&entry["commitment"]).try_into().unwrap());
            snapshot
                .slots
                .push(unhex(&entry["slot"]).try_into().unwrap());
            let parent = &entry["parentIndexPlusOne"];
            snapshot.parents.push(
                parent
                    .as_u64()
                    .or_else(|| parent.as_str().and_then(|text| text.parse().ok()))
                    .unwrap(),
            );
            snapshot.usable.push(true);
        }
        let (params, _) =
            e3_fhe_params::build_pair_for_preset(BfvPreset::InsecureThreshold64).unwrap();
        let root = U256::from_be_slice(&unhex(&fixture["inputRoot"]));
        (
            e3_fhe_params::encode_bfv_params(&params),
            snapshot,
            SubmittedRoot {
                input_root: root.to_string(),
                num_inputs: fixture["inputs"].as_array().unwrap().len() as u64,
            },
        )
    }

    /// The rebuilt root is the one the contract produced, for one leaf and for several.
    #[tokio::test]
    async fn the_rebuilt_root_is_the_one_a_contract_produced() {
        for fixture in [SINGLE_INPUT_TREE, THREE_INPUT_TREE] {
            let (params, snapshot, root) = contract_tree(fixture);
            let count = snapshot.ciphertexts.len();

            let snapshot = verify_input_root(params, snapshot, &root).await.unwrap();

            assert_eq!(snapshot.ciphertexts.len(), count);
        }
    }

    /// An input set that is not the one the root commits to is refused, though its size matches.
    #[tokio::test]
    async fn a_root_over_other_inputs_is_refused() {
        let (params, mut snapshot, root) = contract_tree(THREE_INPUT_TREE);
        // Entry 1 is not selected, so the output stands and only its leaf, and so the root, moves.
        snapshot.commitments[1][0] ^= 1;
        let error = verify_input_root(params.clone(), snapshot, &root)
            .await
            .err()
            .expect("another commitment builds another tree");
        assert!(error.to_string().contains("refusing to compute"), "{error}");

        let (_, snapshot, mut root) = contract_tree(THREE_INPUT_TREE);
        root.input_root = "1".to_string();
        assert!(verify_input_root(params, snapshot, &root).await.is_err());
    }

    #[test]
    fn a_round_is_over_when_it_failed_or_its_compute_window_passed_without_an_output() {
        // The stage alone ends it when it failed or already holds an output.
        for stage in [E3Stage::Failed, E3Stage::CiphertextReady, E3Stage::Complete] {
            assert!(is_over(&stage, u64::MAX, 0), "{stage:?}");
        }
        // Still waiting for the compute: over once the deadline has passed.
        assert!(!is_over(&E3Stage::KeyPublished, 100, 99));
        assert!(is_over(&E3Stage::KeyPublished, 100, 100));
        // Interfold sets the deadline at key publication: zero means not set yet, not passed.
        assert!(!is_over(&E3Stage::Requested, 0, 1_794_000_000));
        assert!(!is_over(&E3Stage::CommitteeFinalized, 0, 1_794_000_000));
    }
}
