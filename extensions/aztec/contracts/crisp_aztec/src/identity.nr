use crate::types::{Config, RoundConfig};
use zkpassport_aztec_verifier::{constants::NULLIFIER_TYPE_NON_SALTED, verify::ServiceConfig};

/// What a registration proof must be made for: this deployment's ZKPassport domain, the round's scope, and a
/// document-bound (non-salted) identifier so that one document registers once per round. Mock documents count only
/// when the round was opened with `allow_mock_documents`.
pub fn service_config(config: Config, round: RoundConfig) -> ServiceConfig {
    ServiceConfig {
        version: config.zkpassport_version,
        domain: config.zkpassport_domain,
        scope: round.scope_hash,
        unique_identifier_type: NULLIFIER_TYPE_NON_SALTED,
        validity_period: config.zkpassport_validity_period,
        dev_mode: round.allow_mock_documents,
    }
}
