// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

//! The BFV preset that the CRISP circuits compile against.
//!
//! `scripts/compile_circuits.sh <preset>` rewrites this file. The committed file selects
//! insecure-64, the preset for local development and pull-request CI.

pub use interfold_lib::configs::insecure::threshold;
