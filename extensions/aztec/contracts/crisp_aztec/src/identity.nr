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

/// What a `register*` entry point may be called for: a round whose age and nationality rules are exactly the ones the
/// entry point proves.
pub fn assert_registration_shape(round: RoundConfig, with_age: bool, with_nationality: bool) {
    if with_age {
        assert(round.min_age != 0, "round has no age requirement");
    } else {
        assert(round.min_age == 0, "round requires an age proof");
    }
    if with_nationality {
        assert(round.nationality_mode != 0, "round has no nationality requirement");
    } else {
        assert(round.nationality_mode == 0, "round requires a nationality proof");
    }
}
