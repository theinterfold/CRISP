// SPDX-License-Identifier: LGPL-3.0-only

//! The staging pass: what `POST /voting/remote-input` requires before it stores bytes and signs.
//!
//! The server attests availability of a ciphertext before the `cast` on the remote chain, so
//! anyone could fill its storage with bytes that are never cast. Requiring the slot's signature
//! would let the server tell a vote from a mask, which the ballot design keeps indistinguishable.
//! A pass (`extensions/core/circuits/staging_pass`) proves only that the sender holds the key of
//! SOME slot registered in the round's census, bound to this request and to a one-time tag, and
//! reveals neither the slot nor the key. The server keeps each tag of a round and refuses a repeat,
//! so a slot key stages at most `STAGING_MAX_REQUESTS_PER_SLOT` ciphertexts a round.
//!
//! The checks run cheapest first and the proof verification last. This is anti-spam, not
//! soundness: the remote contract checks the ballot and the census root itself.
//!
//! The proof is verified by the Barretenberg CLI (`bb verify`), the pinned 6.0.0 that made the
//! verification key. No workspace crate verifies an UltraHonk proof natively, and a verifier of
//! our own would be a second implementation of the protocol to keep in step with `bb`. A
//! subprocess costs tens of milliseconds, so the number of concurrent verifications and the time
//! one may take are bounded.

use super::*;
use crisp_remote_input::{staging_request_digest, RemoteInputSource, StagingPassStatement};
use std::{
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
use tokio::process::Command;

/// The Barretenberg version the verification key belongs to. A proof made with the key of another
/// version cannot verify, so the server refuses to start with a different `bb`.
const BB_VERSION: &str = "6.0.0";
/// One verification takes tens of milliseconds; a hung `bb` must not hold a slot forever.
const VERIFY_TIMEOUT: Duration = Duration::from_secs(30);
/// `bb` is multi-threaded and the endpoint is public: a few at a time are enough.
const MAX_CONCURRENT_VERIFICATIONS: usize = 2;
/// How long a request may wait for a verification slot before it is turned away (503). Forcing a
/// verification needs only public data, so the queue must not grow with the flood.
const VERIFY_QUEUE_TIMEOUT: Duration = Duration::from_secs(2);
/// The bytes of a proof of each pass circuit: fixed by its size (zero knowledge, `evm`). Anything
/// else cannot verify, so it is refused before `bb` is spawned.
/// `staging_pass`, 2^17 gates.
const PROOF_BYTES: usize = 9152;
/// `staging_pass_votes`, 2^15 gates.
const VOTES_PROOF_BYTES: usize = 8384;
/// The most often the remote chain is asked for census roots of one round on behalf of requests
/// that name a root not known yet.
const ROOT_REFRESH_INTERVAL: Duration = Duration::from_secs(5);

/// Why a staging pass was refused. The message reaches the caller.
const MALFORMED: &str = "The staging pass is malformed";
const NOT_FOR_REQUEST: &str = "The staging pass was not made for this request";
const WRONG_LIMIT: &str = "The staging pass was made for another request limit";
const UNKNOWN_ROOT: &str = "The staging pass names a census root this round has not had";
const TAG_USED: &str = "The staging pass was already used";
const BAD_PROOF: &str = "The staging pass proof is invalid";

/// Checks a staging pass proof against the key of the circuit.
#[async_trait::async_trait]
pub(super) trait PassVerifier: Send + Sync {
    /// `Ok(true)` for a valid proof of these public inputs (raw 32-byte fields, concatenated),
    /// `Ok(false)` for one that is not, `Err` when the check could not be run.
    async fn verify(&self, proof: &[u8], public_inputs: &[u8]) -> anyhow::Result<bool>;
}

/// `bb verify` with the verification key of the circuit.
pub(super) struct BbVerifier {
    bb: PathBuf,
    vk: PathBuf,
    crs: Option<PathBuf>,
    slots: Semaphore,
}

impl BbVerifier {
    /// Fail at startup, not on the first pass: the key must be there and `bb` must be the version
    /// that made it.
    pub(super) fn new(bb: &str, vk: &str, crs: Option<&str>) -> anyhow::Result<Self> {
        anyhow::ensure!(
            std::fs::metadata(vk).is_ok_and(|key| key.len() > 0),
            "STAGING_PASS_VK_PATH '{vk}' is not a readable, non-empty verification key"
        );
        let output = std::process::Command::new(bb)
            .arg("--version")
            .output()
            .map_err(|error| anyhow::anyhow!("BB_BINARY_PATH '{bb}' cannot run: {error}"))?;
        let version = String::from_utf8_lossy(&output.stdout);
        anyhow::ensure!(
            version.trim() == BB_VERSION,
            "BB_BINARY_PATH '{bb}' is bb {}, but the staging pass key needs {BB_VERSION}",
            version.trim()
        );
        Ok(Self {
            bb: bb.into(),
            vk: vk.into(),
            crs: crs.map(Into::into),
            slots: Semaphore::new(MAX_CONCURRENT_VERIFICATIONS),
        })
    }

    async fn run(&self, dir: &Path, proof: &[u8], public_inputs: &[u8]) -> anyhow::Result<bool> {
        tokio::fs::create_dir(dir).await?;
        let (proof_path, inputs_path) = (dir.join("proof"), dir.join("public_inputs"));
        tokio::fs::write(&proof_path, proof).await?;
        tokio::fs::write(&inputs_path, public_inputs).await?;
        // The default target, `evm` (keccak transcript, zero knowledge), which the SDK proves with.
        let mut command = Command::new(&self.bb);
        command
            .args(["verify", "-t", "evm", "-p"])
            .arg(&proof_path)
            .arg("-i")
            .arg(&inputs_path)
            .arg("-k")
            .arg(&self.vk)
            .kill_on_drop(true);
        if let Some(crs) = &self.crs {
            command.arg("--crs_path").arg(crs);
        }
        let verification = command.output();
        let output = tokio::time::timeout(VERIFY_TIMEOUT, verification)
            .await
            .map_err(|_| anyhow::anyhow!("bb verify did not finish in {VERIFY_TIMEOUT:?}"))??;
        if !output.status.success() {
            tracing::debug!(
                "bb verify refused a staging pass: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            );
        }
        Ok(output.status.success())
    }
}

#[async_trait::async_trait]
impl PassVerifier for BbVerifier {
    async fn verify(&self, proof: &[u8], public_inputs: &[u8]) -> anyhow::Result<bool> {
        let _slot = tokio::time::timeout(VERIFY_QUEUE_TIMEOUT, self.slots.acquire())
            .await
            .map_err(|_| anyhow::anyhow!("the staging pass verifier is busy"))??;
        let dir =
            std::env::temp_dir().join(format!("crisp-staging-pass-{:016x}", rand::random::<u64>()));
        let verified = self.run(&dir, proof, public_inputs).await;
        let _ = tokio::fs::remove_dir_all(&dir).await;
        verified
    }
}

/// The census roots of one round.
#[derive(Default)]
struct RoundRoots {
    /// Roots seen so far. Behind a plain lock so a known root is answered without waiting for any
    /// read of the chain.
    known: Mutex<HashSet<U256>>,
    refresh: tokio::sync::Mutex<Refresh>,
}

#[derive(Default)]
struct Refresh {
    /// Where the proven blocks have been read to: only ever a position of a proven block, because
    /// the node replaces the blocks of an epoch that is never proven.
    proven_cursor: Option<String>,
    /// When the chain was last asked on behalf of an unknown root.
    last: Option<Instant>,
}

/// What a staging pass is checked against.
pub(super) struct StagingPasses {
    verifier: Arc<dyn PassVerifier>,
    /// The pass limit this server serves (`STAGING_MAX_REQUESTS_PER_SLOT`).
    max_requests: u32,
    chain_id: u64,
    program: Address,
    /// The proof size of the circuit the verification key belongs to.
    proof_bytes: usize,
    refresh_interval: Duration,
    /// Roots by round, read from the remote chain on demand and kept until the round is released.
    roots: Mutex<HashMap<U256, Arc<RoundRoots>>>,
    /// The program and input deadline of each round, which do not change once it is requested.
    windows: Mutex<HashMap<U256, (Address, u64)>>,
}

impl StagingPasses {
    pub(super) fn new(
        verifier: Arc<dyn PassVerifier>,
        max_requests: u32,
        chain_id: u64,
        program: Address,
    ) -> Self {
        Self {
            verifier,
            max_requests,
            chain_id,
            program,
            proof_bytes: PROOF_BYTES,
            refresh_interval: ROOT_REFRESH_INTERVAL,
            roots: Mutex::default(),
            windows: Mutex::default(),
        }
    }

    /// Check the passes of `staging_pass_votes`, the circuit of `PROGRAM_KIND=aztec-votes`.
    pub(super) fn for_votes(mut self) -> Self {
        self.proof_bytes = VOTES_PROOF_BYTES;
        self
    }

    #[cfg(test)]
    pub(super) fn with_refresh_interval(mut self, interval: Duration) -> Self {
        self.refresh_interval = interval;
        self
    }

    pub(super) fn cached_window(&self, e3_id: U256) -> Option<(Address, u64)> {
        lock(&self.windows).get(&e3_id).copied()
    }

    pub(super) fn cache_window(&self, e3_id: U256, program: Address, input_end: u64) {
        lock(&self.windows).insert(e3_id, (program, input_end));
    }

    pub(super) fn max_requests(&self) -> u32 {
        self.max_requests
    }

    /// Everything the pass states that is a function of the request and the configuration:
    /// well-formed public inputs, the digest of this request, this round and this limit.
    fn screen(
        &self,
        e3_id: U256,
        request: &RemoteInputRequest,
    ) -> anyhow::Result<(StagingPassStatement, Vec<u8>, Vec<u8>)> {
        let pass = &request.staging_pass;
        let (statement, public_inputs) = StagingPassStatement::parse(&pass.public_inputs)
            .map_err(|_| reject_input(MALFORMED))?;
        let proof = hex::decode(pass.proof.strip_prefix("0x").unwrap_or(&pass.proof))
            .ok()
            .filter(|proof| proof.len() == self.proof_bytes)
            .ok_or_else(|| reject_input(MALFORMED))?;

        let digest = staging_request_digest(
            self.chain_id,
            self.program,
            e3_id,
            request.commitment,
            request.slot,
            request.parent_index_plus_one,
        );
        let round_id = e3_id & ((U256::from(1u8) << 96usize) - U256::from(1u8));
        if statement.request_digest != digest || statement.round_id != round_id {
            return Err(reject_input(NOT_FOR_REQUEST));
        }
        if statement.max_requests != self.max_requests {
            return Err(reject_input(WRONG_LIMIT));
        }
        Ok((statement, proof, public_inputs))
    }

    /// Whether `root` is a census root of the round.
    ///
    /// A known root is answered at once. An unknown one makes at most one read of the chain per
    /// round at a time and one per `refresh_interval`: a voter who registered a moment ago retries,
    /// while a flood of made-up roots costs the node one read per interval and no more. The refresh
    /// pages the proven blocks from the saved cursor, then reads the unproven tail to the newest
    /// block without saving a position there: those blocks can be replaced, and a cursor past them
    /// would skip their replacements for good.
    async fn has_root(
        &self,
        source: &dyn RemoteInputSource,
        e3_id: U256,
        root: U256,
    ) -> anyhow::Result<bool> {
        let round = Arc::clone(lock(&self.roots).entry(e3_id).or_default());
        if lock(&round.known).contains(&root) {
            return Ok(true);
        }
        let mut refresh = round.refresh.lock().await;
        // The refresh this request waited for may have found it.
        if lock(&round.known).contains(&root) {
            return Ok(true);
        }
        if refresh
            .last
            .is_some_and(|last| last.elapsed() < self.refresh_interval)
        {
            return Ok(false);
        }
        refresh.last = Some(Instant::now());

        let mut tail = None;
        for proven_only in [true, false] {
            let mut cursor = if proven_only {
                refresh.proven_cursor.clone()
            } else {
                tail.clone().or_else(|| refresh.proven_cursor.clone())
            };
            loop {
                let page = source
                    .census_roots(e3_id, cursor.as_deref(), proven_only)
                    .await
                    .map_err(from_eyre)?;
                lock(&round.known).extend(page.roots);
                if page.scanned_to.is_some() {
                    cursor = page.scanned_to;
                }
                if proven_only {
                    refresh.proven_cursor = cursor.clone();
                } else {
                    tail = cursor.clone();
                }
                if !page.more {
                    break;
                }
            }
        }
        let found = lock(&round.known).contains(&root);
        Ok(found)
    }

    /// Forget a finished round's roots.
    pub(super) fn forget(&self, e3_id: U256) {
        lock(&self.roots).remove(&e3_id);
        lock(&self.windows).remove(&e3_id);
    }
}

/// A tag a request holds until its staging is done: kept when the request is refused for
/// something it did wrong, given back when the server failed it.
pub(super) struct StagingTicket {
    pub(super) e3_id: U256,
    pub(super) tag: B256,
}

fn tag_key(e3_id: U256, tag: B256) -> [u8; 64] {
    let mut key = [0u8; 64];
    key[..32].copy_from_slice(&e3_id.to_be_bytes::<32>());
    key[32..].copy_from_slice(tag.as_slice());
    key
}

impl AvailabilityService {
    /// Admit a staging request: check its pass, cheapest first, and take its tag.
    ///
    /// The order is the cost: the request's own facts, the round, the census root (a read of the
    /// remote chain only for a root not seen yet), the tag, and last the proof. The tag is taken
    /// after the proof, atomically, so two requests of one pass cannot both stage.
    pub(super) async fn admit_staging_pass(
        &self,
        e3_id: U256,
        request: &RemoteInputRequest,
    ) -> anyhow::Result<StagingTicket> {
        let remote = self
            .remote
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("this instance does not serve a remote program"))?;
        let passes = &remote.passes;
        let (statement, proof, public_inputs) = passes.screen(e3_id, request)?;

        if !passes
            .has_root(remote.source.as_ref(), e3_id, statement.census_root)
            .await?
        {
            return Err(reject_input(UNKNOWN_ROOT));
        }
        let key = tag_key(e3_id, statement.tag);
        if self.staging_tags.contains_key(key)? {
            return Err(reject_input(TAG_USED));
        }
        if !passes.verifier.verify(&proof, &public_inputs).await? {
            return Err(reject_input(BAD_PROOF));
        }
        // The tag is the pass's identity; of two requests that both passed the check above, one wins.
        if self
            .staging_tags
            .compare_and_swap(key, None as Option<&[u8]>, Some(&[1u8][..]))?
            .is_err()
        {
            return Err(reject_input(TAG_USED));
        }
        self.staging_tags.flush()?;
        Ok(StagingTicket {
            e3_id,
            tag: statement.tag,
        })
    }

    /// Give a tag back after the server failed a request that was not the caller's fault, so the
    /// caller can retry with the same pass.
    pub(super) fn return_staging_tag(&self, ticket: &StagingTicket) -> anyhow::Result<()> {
        self.staging_tags
            .remove(tag_key(ticket.e3_id, ticket.tag))?;
        self.staging_tags.flush()?;
        Ok(())
    }

    /// The pass limit the SDK has to prove against, when this instance serves a remote program.
    pub fn staging_max_requests(&self) -> Option<u32> {
        self.remote
            .as_ref()
            .map(|remote| remote.passes.max_requests())
    }

    /// Drop the tags and census roots of a finished round.
    pub(super) fn release_staging_passes(&self, e3_id: U256) -> anyhow::Result<()> {
        if let Some(remote) = &self.remote {
            remote.passes.forget(e3_id);
        }
        for entry in self.staging_tags.scan_prefix(e3_id.to_be_bytes::<32>()) {
            self.staging_tags.remove(entry?.0)?;
        }
        self.staging_tags.flush()?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::{data_availability::tests::test_service, models::StagingPassSubmission};
    use crisp_remote_input::CensusRootPage;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// A real pass made by `extensions/aztec/sdk/tests/staging-pass.test.ts`
    /// (`WRITE_STAGING_FIXTURE=1`) for the request it names.
    const FIXTURE: &str = include_str!("../../../tests/fixtures/staging_pass.json");
    /// The pass the same test made with `staging_pass_votes`, for the same request.
    const VOTES_FIXTURE: &str = include_str!("../../../tests/fixtures/staging_pass_votes.json");
    const CHAIN_ID: u64 = 11_155_111;

    fn fixture() -> serde_json::Value {
        serde_json::from_str(FIXTURE).unwrap()
    }

    fn e3_id() -> U256 {
        U256::from_str_radix(fixture()["e3_id"].as_str().unwrap(), 10).unwrap()
    }

    fn program() -> Address {
        fixture()["program"].as_str().unwrap().parse().unwrap()
    }

    fn request() -> RemoteInputRequest {
        let fixture = fixture();
        RemoteInputRequest {
            e3_id: fixture["e3_id"].as_str().unwrap().to_owned(),
            slot: fixture["slot"].as_str().unwrap().parse().unwrap(),
            ciphertext: b"ciphertext".to_vec(),
            commitment: fixture["ciphertext_commitment"]
                .as_str()
                .unwrap()
                .parse()
                .unwrap(),
            parent_index_plus_one: fixture["parent_index_plus_one"].as_u64().unwrap(),
            staging_pass: serde_json::from_value::<StagingPassSubmission>(
                fixture["staging_pass"].clone(),
            )
            .unwrap(),
        }
    }

    /// The census root the fixture's pass names.
    fn census_root() -> U256 {
        U256::from_str_radix(
            request().staging_pass.public_inputs[0].trim_start_matches("0x"),
            16,
        )
        .unwrap()
    }

    /// A chain whose census roots are `roots`, the first `proven` of them in proven blocks. It
    /// answers one root a page and records each read.
    struct Chain {
        roots: Mutex<Vec<U256>>,
        proven: AtomicUsize,
        reads: Mutex<Vec<(Option<String>, bool)>>,
    }

    impl Chain {
        fn with(roots: Vec<U256>) -> Arc<Self> {
            let proven = roots.len();
            Arc::new(Self {
                roots: Mutex::new(roots),
                proven: AtomicUsize::new(proven),
                reads: Mutex::default(),
            })
        }

        fn reads(&self) -> usize {
            lock(&self.reads).len()
        }
    }

    #[async_trait::async_trait]
    impl RemoteInputSource for Chain {
        async fn fetch_inputs(
            &self,
            _: U256,
            _: Option<&str>,
        ) -> eyre::Result<crisp_remote_input::InputPage> {
            unreachable!("staging reads no inputs")
        }

        async fn census_roots(
            &self,
            _: U256,
            after: Option<&str>,
            proven_only: bool,
        ) -> eyre::Result<CensusRootPage> {
            lock(&self.reads).push((after.map(str::to_owned), proven_only));
            let mut roots = lock(&self.roots).clone();
            if proven_only {
                roots.truncate(self.proven.load(Ordering::SeqCst));
            }
            let next = after.map_or(0, |after| after.parse::<usize>().unwrap() + 1);
            Ok(CensusRootPage {
                roots: roots.get(next).copied().into_iter().collect(),
                scanned_to: (next < roots.len()).then(|| next.to_string()),
                more: next + 1 < roots.len(),
            })
        }

        async fn latest_timestamp(&self) -> eyre::Result<u64> {
            Ok(0)
        }
    }

    /// Accepts or refuses every proof, and counts the checks.
    struct Verdict(bool, AtomicUsize);

    #[async_trait::async_trait]
    impl PassVerifier for Verdict {
        async fn verify(&self, _: &[u8], _: &[u8]) -> anyhow::Result<bool> {
            self.1.fetch_add(1, Ordering::SeqCst);
            Ok(self.0)
        }
    }

    fn service_with(
        chain: Arc<Chain>,
        verifier: Arc<dyn PassVerifier>,
        max_requests: u32,
    ) -> AvailabilityService {
        let mut service = test_service(1024);
        service.remote = Some(RemoteInputs::for_test(
            chain,
            StagingPasses::new(verifier, max_requests, CHAIN_ID, program())
                .with_refresh_interval(Duration::ZERO),
        ));
        service
    }

    fn accepting() -> (Arc<Verdict>, AvailabilityService) {
        let verdict = Arc::new(Verdict(true, AtomicUsize::new(0)));
        let service = service_with(Chain::with(vec![census_root()]), verdict.clone(), 16);
        (verdict, service)
    }

    fn refused(result: anyhow::Result<StagingTicket>) -> &'static str {
        input_rejection_message(&result.err().expect("the pass was admitted"))
            .expect("a refusal of the caller")
    }

    #[tokio::test]
    async fn a_pass_for_the_request_is_admitted_once() {
        let (verdict, service) = accepting();

        service
            .admit_staging_pass(e3_id(), &request())
            .await
            .unwrap();
        assert_eq!(verdict.1.load(Ordering::SeqCst), 1);

        // The same pass again, whatever the bytes: its tag is spent, and the proof is not checked twice.
        assert_eq!(
            refused(service.admit_staging_pass(e3_id(), &request()).await),
            TAG_USED
        );
        assert_eq!(verdict.1.load(Ordering::SeqCst), 1);
    }

    #[tokio::test]
    async fn a_pass_made_for_other_bytes_is_refused() {
        let (verdict, service) = accepting();

        let mut other_bytes = request();
        other_bytes.commitment = B256::repeat_byte(0x99);
        assert_eq!(
            refused(service.admit_staging_pass(e3_id(), &other_bytes).await),
            NOT_FOR_REQUEST
        );

        let mut other_slot = request();
        other_slot.slot = Address::repeat_byte(0x42);
        assert_eq!(
            refused(service.admit_staging_pass(e3_id(), &other_slot).await),
            NOT_FOR_REQUEST
        );

        let mut other_parent = request();
        other_parent.parent_index_plus_one += 1;
        assert_eq!(
            refused(service.admit_staging_pass(e3_id(), &other_parent).await),
            NOT_FOR_REQUEST
        );

        // Another round of the same program: the digest and the round id are the round's.
        let other_round = e3_id() + U256::from(1);
        assert_eq!(
            refused(service.admit_staging_pass(other_round, &request()).await),
            NOT_FOR_REQUEST
        );

        // Another program or chain: a service of a different deployment.
        let mut other_program = test_service(1024);
        other_program.remote = Some(RemoteInputs::for_test(
            Chain::with(vec![census_root()]),
            StagingPasses::new(verdict.clone(), 16, CHAIN_ID, Address::repeat_byte(0x11)),
        ));
        assert_eq!(
            refused(other_program.admit_staging_pass(e3_id(), &request()).await),
            NOT_FOR_REQUEST
        );

        // Nothing was verified or spent.
        assert_eq!(verdict.1.load(Ordering::SeqCst), 0);
        service
            .admit_staging_pass(e3_id(), &request())
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn a_pass_for_another_limit_is_refused() {
        let verdict = Arc::new(Verdict(true, AtomicUsize::new(0)));
        // The pass was proved for 16; this server allows 8.
        let service = service_with(Chain::with(vec![census_root()]), verdict.clone(), 8);

        assert_eq!(
            refused(service.admit_staging_pass(e3_id(), &request()).await),
            WRONG_LIMIT
        );
        assert_eq!(verdict.1.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn a_malformed_pass_is_refused() {
        let (_, service) = accepting();

        let mut short = request();
        short.staging_pass.public_inputs.pop();
        assert_eq!(
            refused(service.admit_staging_pass(e3_id(), &short).await),
            MALFORMED
        );

        let mut not_hex = request();
        not_hex.staging_pass.proof = "0xnothex".into();
        assert_eq!(
            refused(service.admit_staging_pass(e3_id(), &not_hex).await),
            MALFORMED
        );

        let mut empty = request();
        empty.staging_pass.proof = "0x".into();
        assert_eq!(
            refused(service.admit_staging_pass(e3_id(), &empty).await),
            MALFORMED
        );

        // A proof of the wrong size cannot verify, so `bb` is never run for it.
        let mut wrong_size = request();
        wrong_size
            .staging_pass
            .proof
            .truncate(wrong_size.staging_pass.proof.len() - 2);
        assert_eq!(
            refused(service.admit_staging_pass(e3_id(), &wrong_size).await),
            MALFORMED
        );
        let mut padded = request();
        padded.staging_pass.proof.push_str("00");
        assert_eq!(
            refused(service.admit_staging_pass(e3_id(), &padded).await),
            MALFORMED
        );

        let mut not_a_field = request();
        not_a_field.staging_pass.public_inputs[5] = format!("0x{}", "ff".repeat(32));
        assert_eq!(
            refused(service.admit_staging_pass(e3_id(), &not_a_field).await),
            MALFORMED
        );
    }

    #[tokio::test]
    async fn a_census_root_the_round_has_not_had_is_refused_until_the_chain_shows_it() {
        let verdict = Arc::new(Verdict(true, AtomicUsize::new(0)));
        // The chain lists two other roots, one a page: both pages are read, and the pass's root is not there.
        let chain = Chain::with(vec![U256::from(1), U256::from(2)]);
        let service = service_with(chain.clone(), verdict.clone(), 16);

        assert_eq!(
            refused(service.admit_staging_pass(e3_id(), &request()).await),
            UNKNOWN_ROOT
        );
        assert!(chain.reads() >= 2);
        assert_eq!(verdict.1.load(Ordering::SeqCst), 0);

        // A member registers: the next pass reads only what is new and finds its root.
        lock(&chain.roots).push(census_root());
        service
            .admit_staging_pass(e3_id(), &request())
            .await
            .unwrap();
        assert!(chain.reads() >= 3);
    }

    #[tokio::test]
    async fn a_root_seen_once_is_not_read_again() {
        let chain = Chain::with(vec![census_root()]);
        let verdict = Arc::new(Verdict(true, AtomicUsize::new(0)));
        let service = service_with(chain.clone(), verdict, 16);

        service
            .admit_staging_pass(e3_id(), &request())
            .await
            .unwrap();
        let reads = chain.reads();
        // The tag is spent, which is checked after the root: the root came from memory.
        assert_eq!(
            refused(service.admit_staging_pass(e3_id(), &request()).await),
            TAG_USED
        );
        assert_eq!(chain.reads(), reads);
    }

    #[tokio::test]
    async fn a_proof_that_does_not_verify_is_refused_and_spends_nothing() {
        let verdict = Arc::new(Verdict(false, AtomicUsize::new(0)));
        let service = service_with(Chain::with(vec![census_root()]), verdict.clone(), 16);

        assert_eq!(
            refused(service.admit_staging_pass(e3_id(), &request()).await),
            BAD_PROOF
        );
        // Refused again for the proof, not for a spent tag: a bad proof does not use up the tag.
        assert_eq!(
            refused(service.admit_staging_pass(e3_id(), &request()).await),
            BAD_PROOF
        );
        assert_eq!(verdict.1.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn two_requests_of_one_pass_cannot_both_be_admitted() {
        let (_, service) = accepting();

        let (one, two) = (request(), request());
        let (first, second) = tokio::join!(
            service.admit_staging_pass(e3_id(), &one),
            service.admit_staging_pass(e3_id(), &two)
        );

        assert_eq!(
            [first.is_ok(), second.is_ok()]
                .iter()
                .filter(|ok| **ok)
                .count(),
            1
        );
    }

    #[tokio::test]
    async fn a_tag_is_given_back_after_a_server_failure_and_dropped_with_its_round() {
        let (_, service) = accepting();

        let ticket = service
            .admit_staging_pass(e3_id(), &request())
            .await
            .unwrap();
        service.return_staging_tag(&ticket).unwrap();
        let ticket = service
            .admit_staging_pass(e3_id(), &request())
            .await
            .unwrap();
        assert_eq!(
            refused(service.admit_staging_pass(e3_id(), &request()).await),
            TAG_USED
        );

        service.release_remote_objects(ticket.e3_id).unwrap();
        service
            .admit_staging_pass(e3_id(), &request())
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn the_limit_is_served_for_the_sdk() {
        let (_, service) = accepting();
        assert_eq!(service.staging_max_requests(), Some(16));
        assert_eq!(test_service(1).staging_max_requests(), None);
    }

    /// The proven cursor never passes a proven block: a root only an unproven block shows is found
    /// by the tail read, which keeps no position, so the replacement of a dropped block is still read.
    #[tokio::test]
    async fn the_saved_cursor_stays_within_the_proven_blocks() {
        let verdict = Arc::new(Verdict(true, AtomicUsize::new(0)));
        // The pass's root is in an unproven block.
        let chain = Chain::with(vec![U256::from(1), census_root()]);
        chain.proven.store(1, Ordering::SeqCst);
        let service = service_with(chain.clone(), verdict, 16);

        service
            .admit_staging_pass(e3_id(), &request())
            .await
            .unwrap();

        // The unproven block is replaced by another one, which holds the root of a later pass.
        *lock(&chain.roots) = vec![U256::from(1), U256::from(2), census_root()];
        let mut later = request();
        later.staging_pass.public_inputs[5] = format!("0x{}", hex::encode([7u8; 32]));
        let mut other_root = later.staging_pass.public_inputs.clone();
        other_root[0] = format!("0x{}", hex::encode(U256::from(2).to_be_bytes::<32>()));
        later.staging_pass.public_inputs = other_root;
        // Not for this request: it is only here to make the server look for the root.
        let _ = service.admit_staging_pass(e3_id(), &later).await;

        for (after, proven_only) in lock(&chain.reads).iter() {
            if *proven_only {
                assert!(
                    matches!(after.as_deref(), None | Some("0")),
                    "a proven read resumed from {after:?}"
                );
            }
        }
        // The replacement block was read although an earlier tail read passed its position.
        let passes = &service.remote.as_ref().unwrap().passes;
        let round = Arc::clone(lock(&passes.roots).get(&e3_id()).unwrap());
        assert!(lock(&round.known).contains(&U256::from(2)));
    }

    #[tokio::test]
    async fn an_unknown_root_costs_the_node_one_read_per_interval() {
        let verdict = Arc::new(Verdict(true, AtomicUsize::new(0)));
        let chain = Chain::with(vec![U256::from(1)]);
        let mut service = test_service(1024);
        service.remote = Some(RemoteInputs::for_test(
            chain.clone(),
            StagingPasses::new(verdict, 16, CHAIN_ID, program())
                .with_refresh_interval(Duration::from_secs(3600)),
        ));

        assert_eq!(
            refused(service.admit_staging_pass(e3_id(), &request()).await),
            UNKNOWN_ROOT
        );
        let reads = chain.reads();
        assert!(reads > 0);

        // The root appears, but the round was read a moment ago: no node call, still unknown.
        lock(&chain.roots).push(census_root());
        for _ in 0..5 {
            assert_eq!(
                refused(service.admit_staging_pass(e3_id(), &request()).await),
                UNKNOWN_ROOT
            );
        }
        assert_eq!(chain.reads(), reads);
    }

    /// A known root is answered while another request's read of the chain is still going.
    #[tokio::test]
    async fn a_known_root_does_not_wait_for_a_refresh() {
        let verdict = Arc::new(Verdict(true, AtomicUsize::new(0)));
        let service = service_with(Chain::with(vec![census_root()]), verdict, 16);
        service
            .admit_staging_pass(e3_id(), &request())
            .await
            .unwrap();

        let passes = &service.remote.as_ref().unwrap().passes;
        let round = Arc::clone(lock(&passes.roots).get(&e3_id()).unwrap());
        let _refreshing = round.refresh.lock().await;
        let source = Chain::with(vec![]);
        let known = tokio::time::timeout(
            Duration::from_secs(1),
            passes.has_root(source.as_ref(), e3_id(), census_root()),
        )
        .await;
        assert!(known.unwrap().unwrap());
        assert_eq!(source.reads(), 0);
    }

    /// With no slot free the request is turned away, not queued without bound.
    #[tokio::test(start_paused = true)]
    async fn a_busy_verifier_turns_requests_away() {
        let verifier = BbVerifier {
            bb: "bb".into(),
            vk: "vk".into(),
            crs: None,
            slots: Semaphore::new(0),
        };
        let error = verifier.verify(&[0; 8], &[0; 8]).await.unwrap_err();
        assert!(error.to_string().contains("busy"));
        // A server-side failure, not a refusal of the caller: it answers 503 and spends nothing.
        assert!(input_rejection_message(&error).is_none());
    }

    #[test]
    fn the_verifier_refuses_a_missing_key_and_a_bb_of_another_version() {
        let dir =
            std::env::temp_dir().join(format!("crisp-vk-test-{:016x}", rand::random::<u64>()));
        std::fs::create_dir(&dir).unwrap();
        let vk = dir.join("vk");
        std::fs::write(&vk, [1u8]).unwrap();
        let vk = vk.to_str().unwrap();

        // `echo --version` prints `--version`, which is not the pinned version.
        assert!(BbVerifier::new("echo", vk, None).is_err());
        assert!(BbVerifier::new("echo", dir.join("missing").to_str().unwrap(), None).is_err());
        assert!(BbVerifier::new("/nonexistent/bb", vk, None).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }

    fn bb() -> String {
        std::env::var("BB_BINARY_PATH").unwrap_or_else(|_| "bb".into())
    }

    fn real_verifier() -> BbVerifier {
        let vk = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../extensions/core/circuits/staging_pass/compiled/staging_pass.vk"
        );
        BbVerifier::new(&bb(), vk, None).unwrap()
    }

    /// The pass of the fixture, in the bytes `bb verify` takes.
    fn real_pass() -> (Vec<u8>, Vec<u8>) {
        let pass = request().staging_pass;
        let (_, inputs) = StagingPassStatement::parse(&pass.public_inputs).unwrap();
        (
            hex::decode(pass.proof.trim_start_matches("0x")).unwrap(),
            inputs,
        )
    }

    /// Needs bb 6.0.0 (`BB_BINARY_PATH`, default `bb` on the PATH): `cargo test -p crisp -- --ignored staging_pass`.
    #[tokio::test]
    #[ignore = "needs the bb 6.0.0 binary"]
    async fn bb_accepts_the_sdks_pass_and_refuses_a_tampered_one() {
        let verifier = real_verifier();
        let (proof, inputs) = real_pass();
        assert!(verifier.verify(&proof, &inputs).await.unwrap());

        let mut flipped = proof.clone();
        flipped[proof.len() / 2] ^= 1;
        assert!(!verifier.verify(&flipped, &inputs).await.unwrap());

        // Public inputs the proof was not made for: the tag, the digest, the root.
        for field in [5usize, 3, 0] {
            let mut tampered = inputs.clone();
            tampered[field * 32 + 31] ^= 1;
            assert!(!verifier.verify(&proof, &tampered).await.unwrap());
        }
        assert!(!verifier
            .verify(&proof[..proof.len() - 32], &inputs)
            .await
            .unwrap());
    }

    /// The whole check with the real verifier: the SDK's pass for its request is admitted, a tampered
    /// proof of the same request is refused for its proof.
    #[tokio::test]
    #[ignore = "needs the bb 6.0.0 binary"]
    async fn the_sdks_pass_is_admitted_with_the_real_verifier() {
        let chain = Chain::with(vec![census_root()]);
        let mut service = test_service(1024);
        service.remote = Some(RemoteInputs::for_test(
            chain,
            StagingPasses::new(Arc::new(real_verifier()), 16, CHAIN_ID, program()),
        ));

        let mut tampered = request();
        let mut proof = hex::decode(tampered.staging_pass.proof.trim_start_matches("0x")).unwrap();
        proof[100] ^= 1;
        tampered.staging_pass.proof = format!("0x{}", hex::encode(proof));
        assert_eq!(
            refused(service.admit_staging_pass(e3_id(), &tampered).await),
            BAD_PROOF
        );

        service
            .admit_staging_pass(e3_id(), &request())
            .await
            .unwrap();
    }

    /// The fixture's request with the votes pass.
    fn votes_request() -> RemoteInputRequest {
        let fixture: serde_json::Value = serde_json::from_str(VOTES_FIXTURE).unwrap();
        RemoteInputRequest {
            staging_pass: serde_json::from_value(fixture["staging_pass"].clone()).unwrap(),
            ..request()
        }
    }

    /// A server of `PROGRAM_KIND=aztec-votes` whose chain has the staging root of `votes_request`.
    fn votes_service(verifier: Arc<dyn PassVerifier>) -> AvailabilityService {
        let root = U256::from_str_radix(
            votes_request().staging_pass.public_inputs[0].trim_start_matches("0x"),
            16,
        )
        .unwrap();
        let mut service = test_service(1024);
        service.remote = Some(RemoteInputs::for_test(
            Chain::with(vec![root]),
            StagingPasses::new(verifier, 16, CHAIN_ID, program()).for_votes(),
        ));
        service
    }

    #[tokio::test]
    async fn each_kind_takes_only_the_pass_of_its_own_circuit() {
        let votes = votes_service(Arc::new(Verdict(true, AtomicUsize::new(0))));
        assert_eq!(
            refused(votes.admit_staging_pass(e3_id(), &request()).await),
            MALFORMED
        );
        votes
            .admit_staging_pass(e3_id(), &votes_request())
            .await
            .unwrap();

        let (_, passport) = accepting();
        assert_eq!(
            refused(passport.admit_staging_pass(e3_id(), &votes_request()).await),
            MALFORMED
        );
    }

    #[tokio::test]
    #[ignore = "needs the bb 6.0.0 binary"]
    async fn the_sdks_votes_pass_is_admitted_with_the_real_verifier() {
        let vk = concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../extensions/core/circuits/staging_pass_votes/compiled/staging_pass_votes.vk"
        );
        let service = votes_service(Arc::new(BbVerifier::new(&bb(), vk, None).unwrap()));
        service
            .admit_staging_pass(e3_id(), &votes_request())
            .await
            .unwrap();
    }
}
