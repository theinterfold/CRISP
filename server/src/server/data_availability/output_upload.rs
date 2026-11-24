// SPDX-License-Identifier: LGPL-3.0-only

//! Upload of this server's aggregate ciphertexts to another CRISP server.
//!
//! In mock data availability the ciphernodes of a testnet read objects from one CRISP server.
//! When this server computes a round for a program that other server does not run, its output is
//! not in that server's store. `EXTERNAL_OUTPUT_UPLOAD_URL` names the availability route of that
//! server, and this module sends the exact output bytes to its `PUT /objects/{hash}` route
//! (`put_external_output`) once Interfold references them.
//!
//! The durable state is the output job that already exists. The mock backend keeps the object of
//! a published job, so every `Submitted` output job without an entry in `output_uploads` still
//! owes an upload, and a restart finds it again. An entry is written when the upload is over:
//! stored, no longer needed, or refused for good.

use super::{
    duration_u64, external_output_refusal, from_eyre, lock, wall_clock_seconds, AvailabilityJob,
    AvailabilityService, JobKind, JobState, StoredE3Stage,
};
use crate::server::{models::e3_id_to_u256, rpc::UPSTREAM_TIMEOUT};
use alloy::{eips::BlockId, primitives::B256};
use e3_evm_client::contracts::InterfoldRead;
use reqwest::{redirect::Policy, StatusCode};
use std::collections::HashMap;
use tracing::{error, info, warn};

/// The wait after the first failed attempt. It doubles after each failure up to the maximum.
const UPLOAD_RETRY_MIN_SECONDS: u64 = 30;
const UPLOAD_RETRY_MAX_SECONDS: u64 = 600;
/// Characters of the receiver's answer that a log line keeps.
const ANSWER_LOG_CHARS: usize = 200;

/// Seconds to wait after the `failures`-th consecutive failure of one upload.
fn retry_delay(failures: u32) -> u64 {
    UPLOAD_RETRY_MIN_SECONDS
        .saturating_mul(1 << failures.saturating_sub(1).min(16))
        .min(UPLOAD_RETRY_MAX_SECONDS)
}

/// The consecutive failures of each pending upload, with the wall-clock second of its next
/// attempt. A restart forgets them, which only repeats an attempt.
pub(super) type UploadRetries = HashMap<String, (u32, u64)>;

/// How an upload ended.
#[derive(Debug, PartialEq, Eq)]
enum UploadEnd {
    /// The receiver stored the output, or already held it.
    Uploaded,
    /// Interfold no longer needs the receiver to hold the output.
    NotNeeded(String),
    /// The receiver refused the request in a way that no retry changes.
    Refused(String),
}

/// What one attempt decided.
#[derive(Debug, PartialEq, Eq)]
enum UploadStep {
    Finished(UploadEnd),
    /// A condition that can clear: try again after a delay.
    Retry(String),
}

/// The receiver's status code as an upload step.
///
/// 2xx is stored. The receiver answers 409 when its own chain view does not yet hold the output
/// (`NotReferenced`), 507 when its allowance is full until an earlier output expires, and 429
/// when it rate-limits the caller, so those and every 5xx retry. Any other status, including a
/// redirect, the 400 of a request that cannot succeed as sent, and the 404 of a receiver that
/// takes no uploads, is final.
fn step_for_status(status: StatusCode, answer: &str) -> UploadStep {
    if status.is_success() {
        return UploadStep::Finished(UploadEnd::Uploaded);
    }
    let detail = format!("the receiver answered {status}: {answer}");
    let transient = status.is_server_error()
        || matches!(
            status,
            StatusCode::REQUEST_TIMEOUT
                | StatusCode::CONFLICT
                | StatusCode::TOO_EARLY
                | StatusCode::TOO_MANY_REQUESTS
        );
    if transient {
        UploadStep::Retry(detail)
    } else {
        UploadStep::Finished(UploadEnd::Refused(detail))
    }
}

/// The availability route of the receiving server.
#[derive(Clone)]
pub(super) struct OutputUploader {
    /// The configured route without a trailing slash.
    base_url: String,
    client: reqwest::Client,
}

impl OutputUploader {
    pub(super) fn new(url: &str) -> anyhow::Result<Self> {
        Ok(Self {
            base_url: url.trim_end_matches('/').to_owned(),
            // A redirect would resend a `PUT` to a place that the operator did not name, or as
            // another method. A receiver that redirects needs its final URL in the configuration.
            client: reqwest::Client::builder()
                .timeout(UPSTREAM_TIMEOUT)
                .redirect(Policy::none())
                .build()?,
        })
    }

    fn object_url(&self, content_hash: B256) -> String {
        format!("{}/objects/{content_hash}", self.base_url)
    }

    /// Send `bytes` as the output of `e3_id`, in the form that `put_external_output` parses: the
    /// `0x`-prefixed keccak256 in the path, the decimal E3 identifier in the `e3_id` query, and
    /// the raw bytes as the body.
    async fn put(&self, e3_id: &str, content_hash: B256, bytes: &[u8]) -> UploadStep {
        let response = self
            .client
            .put(self.object_url(content_hash))
            .query(&[("e3_id", e3_id)])
            .header(reqwest::header::CONTENT_TYPE, "application/octet-stream")
            .body(bytes.to_vec())
            .send()
            .await;
        let response = match response {
            Ok(response) => response,
            // The error text carries the URL, which names the receiver.
            Err(error) => return UploadStep::Retry(error.without_url().to_string()),
        };
        let status = response.status();
        let answer = response.text().await.unwrap_or_default();
        step_for_status(
            status,
            &answer.chars().take(ANSWER_LOG_CHARS).collect::<String>(),
        )
    }
}

impl AvailabilityService {
    /// Upload every published output of this server that the receiver may still need. Does
    /// nothing without `EXTERNAL_OUTPUT_UPLOAD_URL`. A failed upload waits for its next attempt
    /// and never stops the others.
    pub(super) async fn drive_output_uploads(&self) {
        let Some(uploader) = &self.output_uploader else {
            return;
        };
        let now = wall_clock_seconds();
        for job in self.pending_output_uploads() {
            if !self.output_upload_due(&job.id, now) {
                continue;
            }
            let step = match self.upload_output(uploader, &job).await {
                Ok(step) => step,
                Err(error) => UploadStep::Retry(format!("{error:#}")),
            };
            // The retry delay counts from the end of this attempt, not from the start of the pass.
            if let Err(error) = self.settle_output_upload(&job, step, wall_clock_seconds()) {
                warn!(job_id = job.id.as_str(), %error, "Could not record an output upload; will retry");
            }
        }
    }

    /// The published output jobs whose upload is not over. An unreadable record is skipped, as
    /// `pending_ids` skips it.
    fn pending_output_uploads(&self) -> Vec<AvailabilityJob> {
        self.all_jobs()
            .filter_map(|job| match job {
                Ok(job) => Some(job),
                Err(error) => {
                    warn!(%error, "Skipping an unreadable data-availability job record");
                    None
                }
            })
            .filter(|job| {
                matches!(job.kind, JobKind::Output { .. })
                    && matches!(job.state, JobState::Submitted { .. })
                    && !self
                        .output_uploads
                        .contains_key(job.id.as_bytes())
                        .unwrap_or(false)
            })
            .collect()
    }

    fn output_upload_due(&self, id: &str, now: u64) -> bool {
        lock(&self.output_upload_retries)
            .get(id)
            .is_none_or(|(_, next_attempt)| now >= *next_attempt)
    }

    /// One attempt for `job`. The checks use the facts and the deadline that the receiver checks
    /// before it stores an output, so an upload is only sent while it can be accepted.
    async fn upload_output(
        &self,
        uploader: &OutputUploader,
        job: &AvailabilityJob,
    ) -> anyhow::Result<UploadStep> {
        let JobKind::Output { e3_id, .. } = &job.kind else {
            anyhow::bail!("data-availability job {} is not an output job", job.id);
        };
        let e3 = e3_id_to_u256(e3_id)?;
        match self.e3_stage(e3, BlockId::latest()).await? {
            StoredE3Stage::CiphertextReady => {}
            // The publication that made the job `Submitted` is not at the head: a reorganization
            // removed it, and the job sends it again.
            StoredE3Stage::KeyPublished => {
                return Ok(UploadStep::Retry(
                    "the E3 does not reference its output at the chain head".to_owned(),
                ))
            }
            stage => {
                return Ok(UploadStep::Finished(UploadEnd::NotNeeded(format!(
                    "the E3 is not waiting for a decryption ({stage:?})"
                ))))
            }
        }
        let interfold = self.interfold_read().await?;
        let output = interfold
            .get_e3(e3)
            .await
            .map_err(from_eyre)?
            .ciphertextOutput;
        let decryption_deadline = duration_u64(
            interfold
                .get_deadlines(e3)
                .await
                .map_err(from_eyre)?
                .decryptionDeadline,
            "decryption deadline",
        )?;
        let now = self.chain_timestamp().await?;
        let content_hash = B256::from(job.content_hash);
        if let Some(reason) =
            external_output_refusal(output, content_hash, decryption_deadline, now)
        {
            return Ok(UploadStep::Finished(UploadEnd::NotNeeded(
                reason.to_owned(),
            )));
        }
        let bytes = self.object_required(job.content_hash)?;
        Ok(uploader.put(e3_id, content_hash, &bytes).await)
    }

    /// Record the outcome of one attempt: a finished upload leaves the pending set for good, and
    /// a retry waits longer after each failure.
    fn settle_output_upload(
        &self,
        job: &AvailabilityJob,
        step: UploadStep,
        now: u64,
    ) -> anyhow::Result<()> {
        let JobKind::Output { e3_id, .. } = &job.kind else {
            anyhow::bail!("data-availability job {} is not an output job", job.id);
        };
        let (job_id, e3_id) = (job.id.as_str(), e3_id.as_str());
        let end = match step {
            UploadStep::Retry(reason) => {
                let mut retries = lock(&self.output_upload_retries);
                let failures = retries.get(job_id).map_or(0, |(failures, _)| *failures) + 1;
                let delay = retry_delay(failures);
                retries.insert(job_id.to_owned(), (failures, now.saturating_add(delay)));
                warn!(
                    job_id,
                    e3_id,
                    failures,
                    "Could not upload the output of the E3; retrying in {delay} seconds: {reason}"
                );
                return Ok(());
            }
            UploadStep::Finished(end) => end,
        };
        let record = match &end {
            UploadEnd::Uploaded => {
                info!(job_id, e3_id, "Uploaded the output of the E3");
                "uploaded".to_owned()
            }
            UploadEnd::NotNeeded(reason) => {
                warn!(
                    job_id,
                    e3_id, "Did not upload the output of the E3: {reason}"
                );
                format!("not needed: {reason}")
            }
            UploadEnd::Refused(reason) => {
                error!(job_id, e3_id, "The upload of the output of the E3 was refused and will not be retried: {reason}");
                format!("refused: {reason}")
            }
        };
        self.output_uploads.insert(job_id, record.as_bytes())?;
        self.output_uploads.flush()?;
        lock(&self.output_upload_retries).remove(job_id);
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::server::{
        data_availability::tests::test_service, rate_limit::ChainRateLimiter, routes::setup_routes,
    };
    use actix_web::{web, App, HttpServer};
    use alloy::primitives::keccak256;

    const OUTPUT: &[u8] = b"aggregate-ciphertext";

    /// The real availability route of a receiving server on a local port, with its service.
    fn receiver(max_bytes: u64) -> (AvailabilityService, String) {
        let mut service = test_service(1024);
        service.external_outputs_max_bytes = max_bytes;
        let data = web::Data::new(service.clone());
        let limiter = web::Data::new(ChainRateLimiter::with_trust(false));
        let server = HttpServer::new(move || {
            App::new()
                .app_data(data.clone())
                .app_data(limiter.clone())
                .configure(setup_routes)
        })
        .workers(1)
        .bind(("127.0.0.1", 0))
        .unwrap();
        let port = server.addrs()[0].port();
        actix_web::rt::spawn(server.run());
        (service, format!("http://127.0.0.1:{port}/availability"))
    }

    fn output_job(id: &str, e3_id: &str, state: JobState) -> AvailabilityJob {
        let mut job = AvailabilityJob::new(
            id.to_owned(),
            keccak256(OUTPUT).0,
            JobKind::Output {
                e3_id: e3_id.to_owned(),
                ciphertext_commitment: [7; 32],
                compute_proof: Vec::new(),
                deadline: u64::MAX,
            },
        );
        job.state = state;
        job
    }

    fn submitted() -> JobState {
        JobState::Submitted {
            transaction_hash: "already-finalized".to_owned(),
        }
    }

    /// The request that the sender builds is the one that `put_external_output` parses. A
    /// receiver that already holds the object answers before any chain read, so a 2xx proves that
    /// the path, the query and the body all parsed. Without the object it goes on to read the
    /// chain, which the test service lacks, and answers 503 only after the same parsing.
    #[actix_web::test]
    async fn the_request_is_the_one_the_receiving_route_parses() {
        let (receiver_service, base) = receiver(1024);
        let hash = keccak256(OUTPUT);

        let unseen = OutputUploader::new(&base).unwrap();
        assert!(matches!(
            unseen.put("12", hash, OUTPUT).await,
            UploadStep::Retry(reason) if reason.contains("503")
        ));

        receiver_service
            .admit_external_output(hash, u64::MAX, 0, OUTPUT)
            .unwrap();
        let stored = UploadStep::Finished(UploadEnd::Uploaded);
        assert_eq!(unseen.put("12", hash, OUTPUT).await, stored);
        // A trailing slash on the configured route changes nothing.
        let slash = OutputUploader::new(&format!("{base}/")).unwrap();
        assert_eq!(slash.put("12", hash, OUTPUT).await, stored);
        assert_eq!(
            receiver_service.object(&format!("{hash}")).unwrap(),
            Some(OUTPUT.to_vec())
        );
        assert_eq!(
            unseen.object_url(hash),
            format!("{base}/objects/0x{}", alloy::hex::encode(hash))
        );
    }

    #[actix_web::test]
    async fn a_receiver_that_refuses_for_good_is_not_retried() {
        let hash = keccak256(OUTPUT);

        // No allowance: the route answers 404.
        let (_, closed) = receiver(0);
        let step = OutputUploader::new(&closed)
            .unwrap()
            .put("12", hash, OUTPUT)
            .await;
        assert!(
            matches!(step, UploadStep::Finished(UploadEnd::Refused(_))),
            "{step:?}"
        );

        // An E3 identifier that is not decimal: the route answers 400.
        let (_, open) = receiver(1024);
        let step = OutputUploader::new(&open)
            .unwrap()
            .put("0x0c", hash, OUTPUT)
            .await;
        assert!(
            matches!(step, UploadStep::Finished(UploadEnd::Refused(_))),
            "{step:?}"
        );

        // Nothing listens: a connection failure retries.
        let step = OutputUploader::new("http://127.0.0.1:1/availability")
            .unwrap()
            .put("12", hash, OUTPUT)
            .await;
        assert!(matches!(step, UploadStep::Retry(_)), "{step:?}");
    }

    #[test]
    fn only_transient_statuses_are_retried() {
        for status in [200, 201, 204] {
            assert_eq!(
                step_for_status(StatusCode::from_u16(status).unwrap(), ""),
                UploadStep::Finished(UploadEnd::Uploaded)
            );
        }
        for status in [408, 409, 425, 429, 500, 502, 503, 507] {
            assert!(
                matches!(
                    step_for_status(StatusCode::from_u16(status).unwrap(), "later"),
                    UploadStep::Retry(_)
                ),
                "{status}"
            );
        }
        for status in [301, 307, 400, 401, 403, 404, 405, 413] {
            assert!(
                matches!(
                    step_for_status(StatusCode::from_u16(status).unwrap(), "no"),
                    UploadStep::Finished(UploadEnd::Refused(_))
                ),
                "{status}"
            );
        }
    }

    #[test]
    fn a_retry_waits_longer_each_time_up_to_a_cap() {
        let delays: Vec<u64> = (1..=7).map(retry_delay).collect();
        assert_eq!(delays, [30, 60, 120, 240, 480, 600, 600]);
        assert_eq!(retry_delay(u32::MAX), 600);
    }

    #[test]
    fn a_final_refusal_ends_the_upload_and_a_retry_does_not() {
        let mut service = test_service(1024);
        service.output_uploader =
            Some(OutputUploader::new("http://127.0.0.1:1/availability").unwrap());
        let refused = output_job("refused", "1", submitted());
        let waiting = output_job("waiting", "2", submitted());
        let in_flight = output_job("in-flight", "3", JobState::Created);
        for job in [&refused, &waiting, &in_flight] {
            service.save(job).unwrap();
        }
        let pending = |service: &AvailabilityService| {
            let mut ids: Vec<_> = service
                .pending_output_uploads()
                .into_iter()
                .map(|job| job.id)
                .collect();
            ids.sort();
            ids
        };
        // A job that is not published yet owes nothing.
        assert_eq!(pending(&service), ["refused", "waiting"]);

        service
            .settle_output_upload(
                &refused,
                UploadStep::Finished(UploadEnd::Refused("the receiver answered 400".into())),
                100,
            )
            .unwrap();
        service
            .settle_output_upload(
                &waiting,
                UploadStep::Retry("the receiver answered 503".into()),
                100,
            )
            .unwrap();
        assert_eq!(pending(&service), ["waiting"]);
        assert!(!service.output_upload_due("waiting", 129));
        assert!(service.output_upload_due("waiting", 130));

        // The decision survives a restart, because it is in the database.
        assert!(service.output_uploads.contains_key("refused").unwrap());
        let record = service.output_uploads.get("refused").unwrap().unwrap();
        assert!(String::from_utf8_lossy(&record).starts_with("refused: "));

        service
            .settle_output_upload(&waiting, UploadStep::Finished(UploadEnd::Uploaded), 130)
            .unwrap();
        assert!(pending(&service).is_empty());
        assert!(service.output_upload_due("waiting", 0));
    }

    /// Without `EXTERNAL_OUTPUT_UPLOAD_URL` nothing is attempted, even for a published output.
    #[tokio::test]
    async fn nothing_is_uploaded_when_the_url_is_unset() {
        let mut service = test_service(1024);
        service
            .save(&output_job("published", "1", submitted()))
            .unwrap();

        service.drive_output_uploads().await;
        assert!(lock(&service.output_upload_retries).is_empty());
        assert!(service.output_uploads.is_empty());

        // The same state with a receiver attempts the upload (here it cannot read the chain, so
        // the attempt is a retry).
        service.output_uploader =
            Some(OutputUploader::new("http://127.0.0.1:1/availability").unwrap());
        service.drive_output_uploads().await;
        assert!(lock(&service.output_upload_retries).contains_key("published"));
    }
}
