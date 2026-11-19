// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

//! The seam between the CRISP server and an L2 that collects the inputs of a round.
//!
//! An L2 extension builds the input tree on its own chain and reports the root to the L1 program
//! (`CRISPRemoteProgram`). The server needs three things from it, and this crate is all of them:
//!
//! - a [`RemoteInputSource`] that lists the inputs an L2 contract accepted, so the server can pair
//!   them with the ciphertexts it staged;
//! - an [`AvailabilityAttester`], because the L2 contract accepts an input only with the server's
//!   promise that it holds the ciphertext, signed against the L1 program;
//! - [`readiness`], the rule that decides when the L1 root and the indexed inputs agree and the
//!   round can be computed.
//!
//! Nothing here names an L2. Adding one means implementing [`RemoteInputSource`] for it.

mod attestation;
mod gating;
mod staging;

pub use attestation::{input_id, Attestation, AvailabilityAttester, InputStatement};
pub use gating::{readiness, Readiness};
pub use staging::{staging_request_digest, StagingPassStatement, STAGING_PASS_PUBLIC_INPUTS};

use alloy::{
    primitives::{Address, B256, U256},
    sol,
};
use async_trait::async_trait;

sol! {
    /// Emitted by `CRISPRemoteProgram` once the L2's input root reached L1. The root is final and
    /// `numInputs` is the number of inputs the server must hold before it computes the round.
    event InputRootSubmitted(uint256 indexed e3Id, uint256 inputRoot, uint256 numInputs);
}

/// One input the L2 contract accepted, in the form of the L1 `InputCommitted` event.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct RemoteInput {
    pub e3_id: U256,
    /// The leaf position in the round's input tree.
    pub index: u64,
    pub slot: Address,
    pub commitment: B256,
    /// `keccak256` of the ciphertext, which names the bytes the server staged.
    pub ciphertext_hash: B256,
    pub parent_index_plus_one: u64,
    /// Where a later fetch resumes strictly after this input.
    pub cursor: String,
}

/// One page of a source's history.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct InputPage {
    /// The inputs of the requested round in this page, in the order the L2 accepted them.
    pub inputs: Vec<RemoteInput>,
    /// The position of the last record the page scanned, including records of other rounds. Resume
    /// from it once every input of the page is stored. `None` when the page scanned nothing.
    pub scanned_to: Option<String>,
    /// Whether a further page may exist.
    pub more: bool,
}

/// One page of the census roots of a round, in the order the L2 produced them.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct CensusRootPage {
    /// The root after each registration of the requested round in this page.
    pub roots: Vec<U256>,
    /// The position of the last record the page scanned, including records of other rounds. Resume
    /// from it. `None` when the page scanned nothing.
    pub scanned_to: Option<String>,
    /// Whether a further page may exist.
    pub more: bool,
}

/// A chain that holds the inputs of rounds whose program lives on L1.
#[async_trait]
pub trait RemoteInputSource: Send + Sync {
    /// The inputs of `e3_id` accepted after `after`, an opaque position this source returned
    /// earlier. `None` starts at the beginning of the source's history.
    async fn fetch_inputs(&self, e3_id: U256, after: Option<&str>) -> eyre::Result<InputPage>;

    /// The census roots of `e3_id` registered after `after`, an opaque position this source
    /// returned earlier. With `proven_only`, only blocks that can no longer be replaced are read, so
    /// a position taken from the page is safe to resume from. Without it the newest blocks are read
    /// too, so a root a voter has just seen is known; those blocks can still be dropped and
    /// replaced, so a position from such a page must NOT be kept. A staging pass names one of these
    /// roots; it is a spam filter and not a soundness input.
    async fn census_roots(
        &self,
        e3_id: U256,
        after: Option<&str>,
        proven_only: bool,
    ) -> eyre::Result<CensusRootPage>;

    /// The timestamp of the newest remote block, in the clock the remote contract compares an
    /// attestation's `expiresAt` against.
    async fn latest_timestamp(&self) -> eyre::Result<u64>;
}
