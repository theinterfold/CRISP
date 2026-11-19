use crate::types::{
    LatestRootPair, MODE_LATEST_AND_PREVIOUS, MODE_LATEST_ONLY, MODE_VALID_AT_TIMESTAMP,
    MODE_VALID_WITHIN_WINDOW, RegistryConfig, RootStatus,
};

pub fn is_root_valid(
    config: RegistryConfig,
    latest_root_pair: LatestRootPair,
    status: RootStatus,
    root: Field,
    timestamp: u64,
) -> bool {
    if !status.exists | status.revoked {
        false
    } else if config.mode == MODE_LATEST_ONLY {
        latest_root_pair.latest == root
    } else if config.mode == MODE_LATEST_AND_PREVIOUS {
        (latest_root_pair.latest == root) | (latest_root_pair.previous == root)
    } else if config.mode == MODE_VALID_AT_TIMESTAMP {
        (timestamp >= status.valid_from) & ((status.valid_to == 0) | (timestamp <= status.valid_to))
    } else if config.mode == MODE_VALID_WITHIN_WINDOW {
        if latest_root_pair.latest == root {
            true // latest is valid in this mode
        } else if timestamp < config.window {
            false
        } else {
            let window_start = timestamp - config.window;
            (status.valid_from <= timestamp)
                & ((status.valid_to == 0) | (status.valid_to >= window_start))
        }
    } else {
        false
    }
}

/// Evaluates root validity only based on existence, revocation status, and validity timestamps
pub fn is_root_valid_at_timestamp(status: RootStatus, timestamp: u64) -> bool {
    status.exists
        & !status.revoked
        & (timestamp >= status.valid_from)
        & ((status.valid_to == 0) | (timestamp <= status.valid_to))
}
