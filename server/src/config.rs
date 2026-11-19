// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

use std::path::Path;
use std::sync::LazyLock;

use alloy::primitives::{
    utils::{ParseUnits, Unit},
    Address, U256,
};
use alloy::providers::Provider;
use config::{Config as ConfigManager, ConfigError, Environment};
use log::warn;
use serde::Deserialize;

use crate::server::rpc;

/// Default for `AVAIL_PROOF_LEAD_SECONDS`: the Avail finalization window.
const AVAIL_FINALIZATION_WINDOW_SECONDS: u64 = 10_800;

/// The program an instance serves. The kinds differ in where inputs live and so in how a round is
/// computed (see `remote_input`).
#[derive(Clone, Copy, Debug, Default, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ProgramKind {
    #[default]
    Crisp,
    Aztec,
    /// A `CRISPGnosisProgram`, whose inputs live on a Gnosis-chain voting contract.
    Gnosis,
}

// Do not derive `Debug`: this structure owns private keys and other secrets.
#[derive(Deserialize)]
pub struct Config {
    pub program_server_url: String,
    pub interfold_server_url: String,
    pub private_key: String,
    pub http_rpc_url: String,
    pub ws_rpc_url: String,
    pub interfold_address: String,
    pub e3_program_address: String,
    pub ciphernode_registry_address: String,
    pub fee_token_address: String,
    /// Eligibility token for CRISP rounds (`MockVotingToken` on localhost); the CLI falls back to
    /// `deployed_contracts.json` when it is unset.
    #[serde(default)]
    pub crisp_voting_token: Option<String>,
    pub chain_id: u64,
    /// `mock` (local chains, or Sepolia with `allow_sepolia_mock_data_availability`) or `avail`.
    /// Defaults by chain.
    #[serde(default)]
    pub data_availability_mode: Option<String>,
    /// Acknowledge mock data availability on Sepolia: ciphertexts live only in this server's
    /// database, and the program checks their hash without an Avail proof.
    #[serde(default)]
    pub allow_sepolia_mock_data_availability: bool,
    #[serde(default)]
    pub avail_rpc_url: Option<String>,
    #[serde(default)]
    pub avail_bridge_api_url: Option<String>,
    #[serde(default)]
    pub avail_app_id: Option<u32>,
    /// Minimum time that must remain before the Ethereum input deadline when an Avail
    /// publication starts. VectorX range proofs are asynchronous, so production must configure
    /// enough headroom for its bridge cadence.
    #[serde(default)]
    pub avail_proof_lead_seconds: Option<u64>,
    /// Avail signer URI.
    #[serde(default)]
    pub avail_seed: Option<String>,
    /// Maximum bytes the service accepts for unfinished availability jobs.
    #[serde(default = "default_da_pending_bytes")]
    pub data_availability_max_pending_bytes: u64,
    /// Bytes this server keeps for the aggregate ciphertexts of other E3 programs on the same
    /// Interfold. Their servers upload them to `PUT /availability/objects/{hash}`, so ciphernodes
    /// that read this server in `mock_http` mode can fetch them. Mock data availability only;
    /// zero (the default) turns the upload route off.
    #[serde(default)]
    pub external_outputs_max_bytes: u64,
    /// Base URL of another CRISP server's availability route, for example
    /// `https://private-crisp.theinterfold.com/availability`. When set, this server uploads each
    /// aggregate ciphertext it publishes to `PUT {url}/objects/{hash}?e3_id={id}`, so ciphernodes
    /// that read that server in `mock_http` mode can fetch it. Mock data availability only; absent
    /// (the default) uploads nothing.
    #[serde(default)]
    pub external_output_upload_url: Option<String>,
    /// Shared secret for the round-scheduler endpoint. Absent disables the endpoint.
    #[serde(default)]
    pub cron_api_key: Option<String>,
    // E3 parameters
    pub e3_param_set: u8,      // 0=InsecureThreshold64, 2=SecureThreshold8192
    pub e3_committee_size: u8, // 0=Minimum, 1=Micro, 2=Small
    pub e3_duration: u64,
    /// Time allowed for the E3 request transaction to be mined before voting can start.
    #[serde(default = "default_voting_start_buffer_seconds")]
    pub voting_start_buffer_seconds: u64,
    pub e3_compute_provider_name: String,
    pub e3_compute_provider_parallel: bool,
    pub e3_compute_provider_batch_size: u32,
    /// Optional on localhost and on deployments that do not use Etherscan-backed holder lookup.
    #[serde(default)]
    pub etherscan_api_key: String,
    /// Block to start indexing from on a fresh database; absent starts at the chain head. A
    /// stored cursor wins on restart.
    #[serde(default)]
    pub index_start_block: Option<u64>,
    /// `eth_getLogs` window for backfill. Lower it if the provider rejects the range.
    #[serde(default)]
    pub index_chunk_size: Option<u64>,
    /// Comma-separated contract addresses the `/chain/*` routes serve. Empty denies every
    /// request: a misconfigured deployment fails closed instead of becoming an open RPC endpoint.
    #[serde(default)]
    pub index_contracts: Option<String>,
    /// Whether to believe `Forwarded` / `X-Forwarded-For` when identifying a caller.
    ///
    /// Off by default: actix takes the header at face value, so without a proxy that overwrites
    /// it a caller can mint a fresh identity per request and the per-caller rate windows bound
    /// nothing. Set it only when every request passes through such a proxy; behind one it must
    /// be set, or every caller shares the proxy's address and one window.
    #[serde(default)]
    pub trust_proxy_headers: bool,

    /// Comma-separated subset of `INDEX_CONTRACTS` whose logs are indexed into the store.
    ///
    /// Serving `eth_call` for a contract is cheap, retaining every log is not: list only the
    /// contracts whose event history clients read. Other contracts stay readable and their log
    /// queries go upstream. Empty means no log indexing; correctness is unaffected.
    #[serde(default)]
    pub index_log_contracts: Option<String>,

    /// Relay input commitments on Ethereum mainnet. Off by default; other chains always relay.
    #[serde(default)]
    pub mainnet_relay: bool,
    /// Relayed input commitments per voting slot per round. Zero turns the relay off.
    #[serde(default = "default_relay_max_inputs_per_slot")]
    pub relay_max_inputs_per_slot: u32,
    /// Relayed input commitments per round. Absent means no limit; zero turns the relay off.
    #[serde(default)]
    pub relay_max_inputs_per_round: Option<u32>,
    /// Stop relaying while the server key holds less than this ETH amount, so that the key keeps
    /// funds for `finalizeInput`. Absent or zero means no floor; `validate_relay` limits both.
    #[serde(default)]
    pub relay_min_balance_eth: Option<String>,

    /// What `E3_PROGRAM_ADDRESS` is: `crisp` (the L1 `CRISPProgram`, the default) or `aztec` (a
    /// `CRISPAztecProgram`, whose inputs live on Aztec). One instance serves one program.
    #[serde(default)]
    pub program_kind: ProgramKind,
    /// The Aztec node whose public logs list the inputs. Required for `PROGRAM_KIND=aztec`.
    #[serde(default)]
    pub aztec_node_url: Option<String>,
    /// The `CrispAztec` contract on Aztec, as a 32-byte hex address. Required for
    /// `PROGRAM_KIND=aztec`.
    #[serde(default)]
    pub aztec_contract_address: Option<String>,
    /// How long an input availability attestation stays valid, counted from the Aztec chain's
    /// latest block. It must outlast proving a ballot and its inclusion on Aztec.
    #[serde(default = "default_aztec_attestation_ttl_seconds")]
    pub aztec_attestation_ttl_seconds: u64,
    /// The first Aztec block that can hold a log of the contract. Absent starts at the first block.
    #[serde(default)]
    pub aztec_start_block: Option<u64>,
    /// How many staging passes one slot key may use per round (`PROGRAM_KIND=aztec`). Each
    /// `POST /voting/remote-input`, vote or mask, spends one, so a slot stages at most this many
    /// ciphertexts a round. The pass circuit takes it as a public input and the SDK proves
    /// against the value of `GET /voting/remote-input/config`.
    #[serde(default = "default_staging_max_requests_per_slot")]
    pub staging_max_requests_per_slot: u32,
    /// The verification key of the `staging_pass` circuit (`extensions/core/circuits/staging_pass/
    /// compiled/staging_pass.vk`). Required for `PROGRAM_KIND=aztec`.
    #[serde(default)]
    pub staging_pass_vk_path: Option<String>,
    /// The Barretenberg CLI that verifies staging passes. Must be the version that made the key
    /// (6.0.0); the Docker image ships it.
    #[serde(default = "default_bb_binary_path")]
    pub bb_binary_path: String,
    /// The directory of `bb`'s reference string. Absent: `bb` uses `~/.bb-crs` and downloads what
    /// it lacks on its first verification. The Docker image ships it, so the server needs no
    /// network and no writable home to verify a pass.
    #[serde(default)]
    pub bb_crs_path: Option<String>,

    /// The HTTP RPC of the chain that holds the ballots (`PROGRAM_KIND=gnosis`): Chiado. The
    /// Interfold chain stays `HTTP_RPC_URL`.
    #[serde(default = "default_gnosis_rpc_url")]
    pub gnosis_rpc_url: String,
    /// The id of that chain: the EIP-712 domain of the ballot and of the availability attestation.
    #[serde(default = "default_gnosis_chain_id")]
    pub gnosis_chain_id: u64,
    /// The `CrispGnosisVoting` contract. Required for `PROGRAM_KIND=gnosis`.
    #[serde(default)]
    pub gnosis_voting_address: Option<String>,
    /// The voting token (`CrispDemoToken`). Required for `PROGRAM_KIND=gnosis`.
    #[serde(default)]
    pub gnosis_token_address: Option<String>,
    /// The first voting-chain block that can hold a log of the voting contract. Required for
    /// `PROGRAM_KIND=gnosis`.
    #[serde(default)]
    pub gnosis_start_block: Option<u64>,
    /// The first block that can hold a log of the token, where holder discovery starts. Absent:
    /// `GNOSIS_START_BLOCK`.
    #[serde(default)]
    pub gnosis_token_start_block: Option<u64>,
    /// How long an availability attestation stays valid, counted from the voting chain's latest
    /// block.
    #[serde(default = "default_gnosis_attestation_ttl_seconds")]
    pub gnosis_attestation_ttl_seconds: u64,
    /// The block explorer of the voting chain, served to clients by the config endpoint.
    #[serde(default = "default_gnosis_explorer_url")]
    pub gnosis_explorer_url: String,
    /// The Gnosis-chain RPC served to browsers by the config endpoint, which may differ from the
    /// server's own `GNOSIS_RPC_URL` (that one can carry an API key).
    #[serde(default = "default_gnosis_rpc_url")]
    pub gnosis_public_rpc_url: String,
    /// Mount `POST /faucet`, which mints voting tokens to the caller's address.
    #[serde(default)]
    pub faucet_enabled: bool,
    /// The key authorised as the token's `faucet`. Required when the faucet is enabled. It is not
    /// `PRIVATE_KEY`: a faucet key that can only mint cannot spend the relay's funds.
    #[serde(default)]
    pub faucet_private_key: Option<String>,
    /// Faucet claims one IP address may make per day, on top of the per-minute caller window.
    #[serde(default = "default_faucet_rate_limit_per_ip_per_day")]
    pub faucet_rate_limit_per_ip_per_day: u32,
}

impl Config {
    pub fn data_availability_mode(&self) -> String {
        self.data_availability_mode.clone().unwrap_or_else(|| {
            if self.is_local_chain() {
                "mock"
            } else {
                "avail"
            }
            .to_owned()
        })
    }

    /// Whether `CHAIN_ID` is a local development chain.
    pub fn is_local_chain(&self) -> bool {
        is_local_chain_id(self.chain_id)
    }

    /// Whether this instance serves rounds whose inputs live on Aztec.
    pub fn is_aztec(&self) -> bool {
        self.program_kind == ProgramKind::Aztec
    }

    /// Whether this instance serves rounds whose inputs live on a Gnosis-chain voting contract.
    pub fn is_gnosis(&self) -> bool {
        self.program_kind == ProgramKind::Gnosis
    }

    /// Whether the inputs of this instance's rounds live on another chain than the L1 program.
    pub fn is_remote(&self) -> bool {
        matches!(self.program_kind, ProgramKind::Aztec | ProgramKind::Gnosis)
    }

    /// The `CrispGnosisVoting` address of a Gnosis instance. `from_env` refuses a missing or
    /// malformed one.
    pub fn gnosis_voting(&self) -> Result<Address, ConfigError> {
        gnosis_address("GNOSIS_VOTING_ADDRESS", self.gnosis_voting_address.as_deref())
    }

    /// The voting token address of a Gnosis instance. `from_env` refuses a missing or malformed
    /// one.
    pub fn gnosis_token(&self) -> Result<Address, ConfigError> {
        gnosis_address("GNOSIS_TOKEN_ADDRESS", self.gnosis_token_address.as_deref())
    }

    /// The first block of token logs that holder discovery reads.
    pub fn gnosis_token_start(&self) -> u64 {
        self.gnosis_token_start_block
            .or(self.gnosis_start_block)
            .unwrap_or_default()
    }

    fn validate_gnosis(&self) -> Result<(), ConfigError> {
        self.gnosis_voting()?;
        self.gnosis_token()?;
        if self.gnosis_start_block.is_none() {
            return Err(invalid("GNOSIS_START_BLOCK is required for PROGRAM_KIND=gnosis"));
        }
        if self.gnosis_rpc_url.trim().is_empty() {
            return Err(invalid("GNOSIS_RPC_URL must not be empty"));
        }
        if self.gnosis_attestation_ttl_seconds == 0 {
            return Err(invalid(
                "GNOSIS_ATTESTATION_TTL_SECONDS must be greater than zero",
            ));
        }
        if self.faucet_enabled {
            let key = self
                .faucet_private_key
                .as_deref()
                .ok_or_else(|| invalid("FAUCET_PRIVATE_KEY is required when FAUCET_ENABLED=true"))?;
            key.parse::<alloy::signers::local::PrivateKeySigner>()
                .map_err(|_| invalid("FAUCET_PRIVATE_KEY is not a private key"))?;
            if self.faucet_rate_limit_per_ip_per_day == 0 {
                return Err(invalid(
                    "FAUCET_RATE_LIMIT_PER_IP_PER_DAY must be greater than zero",
                ));
            }
        }
        Ok(())
    }

    /// The `CrispAztec` contract address of an Aztec instance. `from_env` refuses a missing or
    /// malformed one.
    pub fn aztec_contract(&self) -> Result<alloy::primitives::B256, ConfigError> {
        self.aztec_contract_address
            .as_deref()
            .ok_or_else(|| invalid("AZTEC_CONTRACT_ADDRESS is required for PROGRAM_KIND=aztec"))?
            .trim()
            .parse()
            .map_err(|_| invalid("AZTEC_CONTRACT_ADDRESS must be a 32-byte hex address"))
    }

    fn validate_program(&self) -> Result<(), ConfigError> {
        if self.is_gnosis() {
            return self.validate_gnosis();
        }
        if !self.is_aztec() {
            return Ok(());
        }
        if self
            .aztec_node_url
            .as_deref()
            .is_none_or(|url| url.trim().is_empty())
        {
            return Err(invalid("AZTEC_NODE_URL is required for PROGRAM_KIND=aztec"));
        }
        self.aztec_contract()?;
        if self
            .staging_pass_vk_path
            .as_deref()
            .is_none_or(|path| path.trim().is_empty())
        {
            return Err(invalid(
                "STAGING_PASS_VK_PATH is required for PROGRAM_KIND=aztec",
            ));
        }
        if self.staging_max_requests_per_slot == 0 {
            return Err(invalid(
                "STAGING_MAX_REQUESTS_PER_SLOT must be greater than zero",
            ));
        }
        if self.aztec_attestation_ttl_seconds == 0 {
            return Err(invalid(
                "AZTEC_ATTESTATION_TTL_SECONDS must be greater than zero",
            ));
        }
        Ok(())
    }

    /// `AVAIL_PROOF_LEAD_SECONDS`, or the Avail finalization window when it is unset.
    pub fn avail_proof_lead(&self) -> u64 {
        self.avail_proof_lead_seconds
            .unwrap_or(AVAIL_FINALIZATION_WINDOW_SECONDS)
    }

    /// The `INDEX_CONTRACTS` read allowlist. `from_env` refuses a malformed entry.
    pub fn index_contracts(&self) -> Vec<Address> {
        parse_addresses("INDEX_CONTRACTS", self.index_contracts.as_deref()).unwrap_or_default()
    }

    /// The `INDEX_LOG_CONTRACTS` log-index list. `from_env` refuses a malformed entry.
    pub fn index_log_contracts(&self) -> Vec<Address> {
        parse_addresses("INDEX_LOG_CONTRACTS", self.index_log_contracts.as_deref())
            .unwrap_or_default()
    }

    /// Base URL for outbound HTTP clients (program-server webhooks, CLI, cron). `0.0.0.0` and
    /// `::` are bind addresses only; connecting to them fails (for example `EADDRNOTAVAIL` on
    /// macOS).
    pub fn interfold_server_url_for_clients(&self) -> String {
        self.interfold_server_url
            .replace("0.0.0.0", "127.0.0.1")
            .replace("[::]", "[::1]")
    }

    pub fn from_env() -> Result<Self, ConfigError> {
        let server_env_path = Path::new("server/.env");
        let loaded = if server_env_path.exists() {
            dotenvy::from_path(server_env_path)
        } else {
            dotenvy::dotenv().map(drop)
        };
        if let Err(e) = loaded {
            if !e.not_found() {
                warn!("Ignoring a malformed .env file: {e}");
            }
        }

        let config: Self = ConfigManager::builder()
            // Example files leave optional settings blank: a blank value is unset, not an empty
            // string to deserialize as a number.
            .add_source(Environment::default().ignore_empty(true))
            .build()?
            .try_deserialize()?;
        Self::validate_e3_param_set(config.chain_id, config.e3_param_set)?;
        if config.e3_committee_size > 2 {
            return Err(invalid(format!(
                "E3_COMMITTEE_SIZE must be 0 (Minimum), 1 (Micro) or 2 (Small), got {}",
                config.e3_committee_size
            )));
        }
        parse_addresses("INDEX_CONTRACTS", config.index_contracts.as_deref())?;
        parse_addresses("INDEX_LOG_CONTRACTS", config.index_log_contracts.as_deref())?;
        config.validate_program()?;
        Self::validate_data_availability(
            config.chain_id,
            &config.data_availability_mode(),
            config.allow_sepolia_mock_data_availability,
            config.avail_proof_lead(),
            config.data_availability_max_pending_bytes,
        )?;
        Self::validate_external_outputs(
            &config.data_availability_mode(),
            config.external_outputs_max_bytes,
        )?;
        Self::validate_external_output_upload(
            &config.data_availability_mode(),
            config.external_output_upload_url.as_deref(),
        )?;
        Self::validate_relay(
            config.chain_id,
            config.mainnet_relay,
            config.relay_max_inputs_per_round,
            config.relay_min_balance()?,
        )?;
        Ok(config)
    }

    /// Refuse an `HTTP_RPC_URL` that serves a chain other than `CHAIN_ID`.
    ///
    /// The chain rules of this server (the mainnet relay flag, the secure parameter set, the
    /// mock data availability) read `CHAIN_ID`, while every transaction goes to the
    /// chain of the RPC. For example, `CHAIN_ID=11155111` with a mainnet RPC would relay on
    /// mainnet without `MAINNET_RELAY`.
    pub async fn validate_rpc_chain(&self) -> anyhow::Result<()> {
        let provider = rpc::http_provider(&self.http_rpc_url).map_err(anyhow::Error::msg)?;
        let rpc_chain_id = provider.get_chain_id().await?;
        anyhow::ensure!(
            rpc_chain_id == self.chain_id,
            "CHAIN_ID ({}) does not match the chain of HTTP_RPC_URL ({rpc_chain_id})",
            self.chain_id
        );
        if self.is_gnosis() {
            let provider =
                rpc::http_provider(&self.gnosis_rpc_url).map_err(anyhow::Error::msg)?;
            let rpc_chain_id = provider.get_chain_id().await?;
            anyhow::ensure!(
                rpc_chain_id == self.gnosis_chain_id,
                "GNOSIS_CHAIN_ID ({}) does not match the chain of GNOSIS_RPC_URL ({rpc_chain_id})",
                self.gnosis_chain_id
            );
        }
        Ok(())
    }

    /// The relay balance floor in wei, from `RELAY_MIN_BALANCE_ETH`.
    pub fn relay_min_balance(&self) -> Result<Option<U256>, ConfigError> {
        Self::parse_relay_min_balance(self.relay_min_balance_eth.as_deref())
    }

    /// Parse a non-negative ETH amount into wei. `parse_ether` alone is not enough: it returns the
    /// absolute value of a negative amount.
    fn parse_relay_min_balance(value: Option<&str>) -> Result<Option<U256>, ConfigError> {
        let Some(value) = value else {
            return Ok(None);
        };
        match ParseUnits::parse_units(value.trim(), Unit::ETHER) {
            Ok(ParseUnits::U256(wei)) => Ok(Some(wei)),
            _ => Err(invalid(format!(
                "RELAY_MIN_BALANCE_ETH must be a non-negative ETH amount, got '{value}'"
            ))),
        }
    }

    /// Refuse a relay without an explicit balance floor outside local chains, and a mainnet relay
    /// that has no round limit or no floor above zero.
    ///
    /// The relay key also pays for `finalizeInput`, so the operator chooses its floor; zero relays
    /// without one. Mainnet relay spends real funds, and the slot limit alone does not bound the
    /// spend of one round.
    fn validate_relay(
        chain_id: u64,
        mainnet_relay: bool,
        max_inputs_per_round: Option<u32>,
        min_balance: Option<U256>,
    ) -> Result<(), ConfigError> {
        if min_balance.is_none() && chain_id != 1 && !is_local_chain_id(chain_id) {
            return Err(invalid(
                "RELAY_MIN_BALANCE_ETH is required outside local chains; set 0 to relay without a floor",
            ));
        }
        if chain_id != 1 || !mainnet_relay {
            return Ok(());
        }
        if max_inputs_per_round.is_none() {
            return Err(invalid(
                "MAINNET_RELAY=true requires RELAY_MAX_INPUTS_PER_ROUND",
            ));
        }
        if min_balance.is_none_or(|floor| floor.is_zero()) {
            return Err(invalid(
                "MAINNET_RELAY=true requires RELAY_MIN_BALANCE_ETH greater than zero",
            ));
        }
        Ok(())
    }

    fn validate_data_availability(
        chain_id: u64,
        mode: &str,
        allow_sepolia_mock: bool,
        proof_lead: u64,
        max_pending_bytes: u64,
    ) -> Result<(), ConfigError> {
        match mode {
            "mock" if is_local_chain_id(chain_id) => return Ok(()),
            "mock" if chain_id == SEPOLIA_CHAIN_ID && allow_sepolia_mock => return Ok(()),
            "mock" => {
                return Err(invalid(
                    "DATA_AVAILABILITY_MODE=mock is allowed only on local development chains, or on Sepolia with ALLOW_SEPOLIA_MOCK_DATA_AVAILABILITY=true",
                ))
            }
            "avail" => {}
            _ => {
                return Err(invalid(format!(
                    "unsupported DATA_AVAILABILITY_MODE '{mode}'"
                )))
            }
        }
        if proof_lead == 0 {
            return Err(invalid(
                "AVAIL_PROOF_LEAD_SECONDS must be greater than zero",
            ));
        }
        if max_pending_bytes < e3_data_availability::MAX_OBJECT_BYTES as u64 {
            return Err(invalid(format!(
                "DATA_AVAILABILITY_MAX_PENDING_BYTES must be at least {}",
                e3_data_availability::MAX_OBJECT_BYTES
            )));
        }
        Ok(())
    }

    /// Refuse an external-output allowance outside mock data availability, where ciphernodes read
    /// Avail and never this server, and one too small for a single object.
    fn validate_external_outputs(mode: &str, max_bytes: u64) -> Result<(), ConfigError> {
        if max_bytes == 0 {
            return Ok(());
        }
        if mode != "mock" {
            return Err(invalid(
                "EXTERNAL_OUTPUTS_MAX_BYTES requires DATA_AVAILABILITY_MODE=mock",
            ));
        }
        if max_bytes < e3_data_availability::MAX_OBJECT_BYTES as u64 {
            return Err(invalid(format!(
                "EXTERNAL_OUTPUTS_MAX_BYTES must be 0 or at least {}",
                e3_data_availability::MAX_OBJECT_BYTES
            )));
        }
        Ok(())
    }

    /// Refuse an upload URL outside mock data availability, where ciphernodes read Avail and
    /// never the other server, and one that cannot be the base of `{url}/objects/{hash}`. The
    /// messages never repeat the URL, which can name a private host.
    fn validate_external_output_upload(mode: &str, url: Option<&str>) -> Result<(), ConfigError> {
        let Some(url) = url else {
            return Ok(());
        };
        if mode != "mock" {
            return Err(invalid(
                "EXTERNAL_OUTPUT_UPLOAD_URL requires DATA_AVAILABILITY_MODE=mock",
            ));
        }
        let url: reqwest::Url = url
            .parse()
            .map_err(|_| invalid("EXTERNAL_OUTPUT_UPLOAD_URL is not a valid URL"))?;
        if !matches!(url.scheme(), "http" | "https") || url.host_str().is_none() {
            return Err(invalid(
                "EXTERNAL_OUTPUT_UPLOAD_URL must be an http(s) URL with a host",
            ));
        }
        if !url.username().is_empty()
            || url.password().is_some()
            || url.query().is_some()
            || url.fragment().is_some()
        {
            return Err(invalid(
                "EXTERNAL_OUTPUT_UPLOAD_URL must be the availability route itself, without credentials, query or fragment",
            ));
        }
        Ok(())
    }

    fn validate_e3_param_set(chain_id: u64, param_set: u8) -> Result<(), ConfigError> {
        if param_set != 0 && param_set != 2 {
            return Err(invalid(format!(
                "E3_PARAM_SET must be 0 (insecure-64) or 2 (secure-8192), got {param_set}"
            )));
        }
        if chain_id == 1 && param_set != 2 {
            return Err(invalid(
                "Ethereum mainnet requires E3_PARAM_SET=2 (secure-8192)",
            ));
        }
        Ok(())
    }
}

const SEPOLIA_CHAIN_ID: u64 = 11_155_111;

const fn is_local_chain_id(chain_id: u64) -> bool {
    matches!(chain_id, 1_337 | 31_337)
}

fn invalid(message: impl Into<String>) -> ConfigError {
    ConfigError::Message(message.into())
}

/// A comma-separated address list. Blank entries are ignored.
fn parse_addresses(name: &str, list: Option<&str>) -> Result<Vec<Address>, ConfigError> {
    list.unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
        .map(|entry| {
            entry
                .parse()
                .map_err(|_| invalid(format!("{name} entry '{entry}' is not an address")))
        })
        .collect()
}

const fn default_da_pending_bytes() -> u64 {
    1024 * 1024 * 1024
}

const fn default_voting_start_buffer_seconds() -> u64 {
    120
}

const fn default_relay_max_inputs_per_slot() -> u32 {
    3
}

const fn default_aztec_attestation_ttl_seconds() -> u64 {
    900
}

const fn default_gnosis_chain_id() -> u64 {
    10_200
}

fn default_gnosis_rpc_url() -> String {
    "https://rpc.chiadochain.net".to_owned()
}

fn default_gnosis_explorer_url() -> String {
    "https://gnosis-chiado.blockscout.com".to_owned()
}

const fn default_gnosis_attestation_ttl_seconds() -> u64 {
    3_600
}

const fn default_faucet_rate_limit_per_ip_per_day() -> u32 {
    5
}

fn gnosis_address(name: &str, value: Option<&str>) -> Result<Address, ConfigError> {
    value
        .ok_or_else(|| invalid(format!("{name} is required for PROGRAM_KIND=gnosis")))?
        .trim()
        .parse()
        .map_err(|_| invalid(format!("{name} is not an address")))
}

const fn default_staging_max_requests_per_slot() -> u32 {
    16
}

fn default_bb_binary_path() -> String {
    "bb".to_owned()
}

/// Loaded on first use; a missing or invalid setting stops the process with its message.
pub static CONFIG: LazyLock<Config> =
    LazyLock::new(|| Config::from_env().expect("Failed to load configuration"));

#[cfg(test)]
mod tests {
    use super::Config;
    use config::{Config as ConfigManager, Environment};
    use std::collections::HashMap;

    #[derive(serde::Deserialize)]
    struct OptionalAvailConfig {
        avail_app_id: Option<u32>,
    }

    #[test]
    fn param_sets_are_limited_and_mainnet_requires_the_secure_one() {
        assert!(Config::validate_e3_param_set(11_155_111, 0).is_ok());
        assert!(Config::validate_e3_param_set(11_155_111, 2).is_ok());
        assert!(Config::validate_e3_param_set(1, 2).is_ok());
        assert!(Config::validate_e3_param_set(1, 0).is_err());
        assert!(Config::validate_e3_param_set(31_337, 1).is_err());
        assert!(Config::validate_e3_param_set(31_337, 3).is_err());
    }

    #[test]
    fn avail_requires_a_nonzero_proof_lead() {
        assert!(Config::validate_data_availability(31_337, "mock", false, 0, 0).is_ok());
        assert!(Config::validate_data_availability(1, "avail", false, 10_800, 1024 * 1024).is_ok());
        assert!(Config::validate_data_availability(1, "avail", false, 0, 1024 * 1024).is_err());
        assert!(Config::validate_data_availability(1, "avail", false, 10_800, 1024).is_err());
    }

    #[test]
    fn mock_data_availability_is_local_or_acknowledged_sepolia_only() {
        assert!(Config::validate_data_availability(1, "mock", false, 0, 0).is_err());
        assert!(Config::validate_data_availability(1, "mock", true, 0, 0).is_err());
        assert!(Config::validate_data_availability(11_155_111, "mock", false, 0, 0).is_err());
        assert!(Config::validate_data_availability(11_155_111, "mock", true, 0, 0).is_ok());
        assert!(Config::validate_data_availability(1_337, "mock", false, 0, 0).is_ok());
        assert!(Config::validate_data_availability(31_337, "mock", false, 0, 0).is_ok());
    }

    #[test]
    fn external_outputs_need_mock_data_availability_and_room_for_one_object() {
        let object = e3_data_availability::MAX_OBJECT_BYTES as u64;
        assert!(Config::validate_external_outputs("avail", 0).is_ok());
        assert!(Config::validate_external_outputs("avail", object).is_err());
        assert!(Config::validate_external_outputs("mock", object - 1).is_err());
        assert!(Config::validate_external_outputs("mock", object).is_ok());
    }

    #[test]
    fn an_output_upload_url_needs_mock_data_availability_and_an_http_route() {
        let route = Some("https://private-crisp.theinterfold.com/availability");
        assert!(Config::validate_external_output_upload("avail", None).is_ok());
        assert!(Config::validate_external_output_upload("mock", None).is_ok());
        assert!(Config::validate_external_output_upload("mock", route).is_ok());
        assert!(Config::validate_external_output_upload(
            "mock",
            Some("http://127.0.0.1:4000/availability/")
        )
        .is_ok());
        assert!(Config::validate_external_output_upload("avail", route).is_err());
        for refused in [
            "private-crisp.theinterfold.com/availability",
            "ftp://private-crisp.theinterfold.com/availability",
            "https://user:secret@private-crisp.theinterfold.com/availability",
            "https://private-crisp.theinterfold.com/availability?key=1",
            "https://private-crisp.theinterfold.com/availability#top",
        ] {
            let error = Config::validate_external_output_upload("mock", Some(refused))
                .expect_err(refused)
                .to_string();
            assert!(!error.contains("secret"), "{error}");
        }
    }

    #[test]
    fn relay_needs_a_round_limit_on_mainnet_and_a_chosen_floor_off_local_chains() {
        let floor = Some(alloy::primitives::U256::from(1));
        assert!(Config::validate_relay(1, true, None, floor).is_err());
        assert!(Config::validate_relay(1, true, Some(500), None).is_err());
        // A zero floor never stops the relay, so it is not a floor.
        assert!(
            Config::validate_relay(1, true, Some(500), Some(alloy::primitives::U256::ZERO))
                .is_err()
        );
        assert!(Config::validate_relay(1, true, Some(500), floor).is_ok());
        // Without the flag, mainnet does not relay, so it needs no round limit and no floor.
        assert!(Config::validate_relay(1, false, None, None).is_ok());
        // Other chains relay without the flag and can leave the round unlimited, but the operator
        // must choose the floor: zero relays without one. Local chains need no floor.
        assert!(Config::validate_relay(11_155_111, false, None, None).is_err());
        let no_floor = Some(alloy::primitives::U256::ZERO);
        assert!(Config::validate_relay(11_155_111, false, None, no_floor).is_ok());
        assert!(Config::validate_relay(31_337, false, None, None).is_ok());
    }

    #[test]
    fn relay_balance_floor_is_a_non_negative_eth_amount() {
        assert_eq!(Config::parse_relay_min_balance(None).unwrap(), None);
        assert_eq!(
            Config::parse_relay_min_balance(Some("0.5")).unwrap(),
            Some(alloy::primitives::U256::from(500_000_000_000_000_000_u128))
        );
        // `parse_ether` alone would read this as a floor of 1 ETH.
        assert!(Config::parse_relay_min_balance(Some("-1")).is_err());
        assert!(Config::parse_relay_min_balance(Some("half")).is_err());
    }

    #[test]
    fn blank_optional_environment_value_is_unset() {
        let source = Environment::default()
            .ignore_empty(true)
            .source(Some(HashMap::from([(
                "AVAIL_APP_ID".to_owned(),
                String::new(),
            )])));
        let config: OptionalAvailConfig = ConfigManager::builder()
            .add_source(source)
            .build()
            .unwrap()
            .try_deserialize()
            .unwrap();
        assert_eq!(config.avail_app_id, None);
    }

    /// Localhost and deployments without Etherscan discovery or the round scheduler set only the
    /// required keys; every other key must stay optional.
    #[test]
    fn only_the_required_keys_must_be_set() {
        let config: Config = serde_json::from_value(serde_json::json!({
            "program_server_url": "http://127.0.0.1:3000",
            "interfold_server_url": "http://127.0.0.1:4000",
            "private_key": "test-key",
            "http_rpc_url": "http://127.0.0.1:8545",
            "ws_rpc_url": "ws://127.0.0.1:8545",
            "interfold_address": "0x1",
            "e3_program_address": "0x2",
            "ciphernode_registry_address": "0x3",
            "fee_token_address": "0x4",
            "chain_id": 31_337,
            "e3_param_set": 0,
            "e3_committee_size": 0,
            "e3_duration": 3_600,
            "e3_compute_provider_name": "test",
            "e3_compute_provider_parallel": false,
            "e3_compute_provider_batch_size": 1
        }))
        .unwrap();

        assert!(config.etherscan_api_key.is_empty());
        assert_eq!(config.cron_api_key, None);
        assert_eq!(config.voting_start_buffer_seconds, 120);
        assert_eq!(config.relay_max_inputs_per_slot, 3);
    }

    fn config_with(program: serde_json::Value) -> Config {
        let mut base = serde_json::json!({
            "program_server_url": "http://127.0.0.1:3000",
            "interfold_server_url": "http://127.0.0.1:4000",
            "private_key": "test-key",
            "http_rpc_url": "http://127.0.0.1:8545",
            "ws_rpc_url": "ws://127.0.0.1:8545",
            "interfold_address": "0x1",
            "e3_program_address": "0x2",
            "ciphernode_registry_address": "0x3",
            "fee_token_address": "0x4",
            "chain_id": 31_337,
            "e3_param_set": 0,
            "e3_committee_size": 0,
            "e3_duration": 3_600,
            "e3_compute_provider_name": "test",
            "e3_compute_provider_parallel": false,
            "e3_compute_provider_batch_size": 1
        });
        base.as_object_mut()
            .unwrap()
            .extend(program.as_object().unwrap().clone());
        serde_json::from_value(base).unwrap()
    }

    #[test]
    fn an_instance_serves_the_l1_program_unless_told_otherwise() {
        let config = config_with(serde_json::json!({}));

        assert!(!config.is_aztec());
        assert!(config.validate_program().is_ok());
        assert_eq!(config.aztec_attestation_ttl_seconds, 900);
    }

    #[test]
    fn an_aztec_instance_needs_its_node_and_a_32_byte_contract() {
        let contract = format!("0x{}", "ab".repeat(32));
        let aztec = |extra: serde_json::Value| {
            let mut program = serde_json::json!({ "program_kind": "aztec" });
            program
                .as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            config_with(program)
        };

        assert!(aztec(serde_json::json!({})).validate_program().is_err());
        assert!(
            aztec(serde_json::json!({ "aztec_node_url": "http://127.0.0.1:8080" }))
                .validate_program()
                .is_err()
        );
        // The key of the staging pass circuit is required, and the limit must allow one pass.
        let staged = |extra: serde_json::Value| {
            let mut program = serde_json::json!({
                "aztec_node_url": "http://127.0.0.1:8080",
                "aztec_contract_address": contract,
            });
            program
                .as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            aztec(program)
        };
        assert!(staged(serde_json::json!({})).validate_program().is_err());
        assert!(staged(serde_json::json!({ "staging_pass_vk_path": " " }))
            .validate_program()
            .is_err());
        assert!(staged(serde_json::json!({
            "staging_pass_vk_path": "staging_pass.vk",
            "staging_max_requests_per_slot": 0
        }))
        .validate_program()
        .is_err());
        assert!(aztec(serde_json::json!({
            "aztec_node_url": "http://127.0.0.1:8080",
            "aztec_contract_address": "0x1234"
        }))
        .validate_program()
        .is_err());
        assert!(aztec(serde_json::json!({
            "aztec_node_url": "http://127.0.0.1:8080",
            "aztec_contract_address": contract,
            "staging_pass_vk_path": "staging_pass.vk",
            "aztec_attestation_ttl_seconds": 0
        }))
        .validate_program()
        .is_err());
        let valid = aztec(serde_json::json!({
            "aztec_node_url": "http://127.0.0.1:8080",
            "aztec_contract_address": contract,
            "staging_pass_vk_path": "staging_pass.vk"
        }));
        assert!(valid.validate_program().is_ok());
        assert!(valid.is_aztec());
        assert_eq!(valid.staging_max_requests_per_slot, 16);
        assert_eq!(valid.bb_binary_path, "bb");
    }

    #[test]
    fn a_gnosis_instance_needs_its_contracts_and_start_block_and_a_faucet_key_when_enabled() {
        let address = "0x00000000000000000000000000000000000000aa";
        let gnosis = |extra: serde_json::Value| {
            let mut program = serde_json::json!({ "program_kind": "gnosis" });
            program
                .as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            config_with(program)
        };
        let valid = serde_json::json!({
            "gnosis_voting_address": address,
            "gnosis_token_address": address,
            "gnosis_start_block": 7
        });

        assert!(gnosis(serde_json::json!({})).validate_program().is_err());
        assert!(gnosis(serde_json::json!({ "gnosis_voting_address": address }))
            .validate_program()
            .is_err());
        assert!(gnosis(serde_json::json!({
            "gnosis_voting_address": address,
            "gnosis_token_address": "0x1234",
            "gnosis_start_block": 7
        }))
        .validate_program()
        .is_err());
        let config = gnosis(valid.clone());
        assert!(config.validate_program().is_ok());
        assert!(config.is_gnosis() && config.is_remote() && !config.is_aztec());
        assert_eq!(config.gnosis_chain_id, 10_200);
        assert_eq!(config.gnosis_rpc_url, "https://rpc.chiadochain.net");
        assert_eq!(config.gnosis_attestation_ttl_seconds, 3_600);
        assert_eq!(config.faucet_rate_limit_per_ip_per_day, 5);
        assert_eq!(config.gnosis_token_start(), 7);

        let enabled = |extra: serde_json::Value| {
            let mut program = valid.clone();
            program["faucet_enabled"] = serde_json::json!(true);
            program
                .as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            gnosis(program)
        };
        assert!(enabled(serde_json::json!({})).validate_program().is_err());
        assert!(enabled(serde_json::json!({ "faucet_private_key": "nope" }))
            .validate_program()
            .is_err());
        assert!(enabled(serde_json::json!({
            "faucet_private_key": format!("0x{}", "11".repeat(32))
        }))
        .validate_program()
        .is_ok());

        // The other kinds are not gnosis.
        assert!(!config_with(serde_json::json!({})).is_remote());
    }
}
