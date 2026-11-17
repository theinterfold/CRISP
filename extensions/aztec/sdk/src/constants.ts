// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

/** BN254 scalar field modulus: every Aztec field element, and every input-tree leaf, is reduced below it. */
export const SNARK_SCALAR_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n

/**
 * Most leaves either tree of a round may hold (2^16). A circom Poseidon costs ~257k L2 gas in a public
 * function and a transaction may spend 6M, so an insert may recompute at most 16 hashes.
 */
export const MAX_LEAVES = 65_536

/** First field of every public log the CRISP contract emits. */
export const LOG_TAG = {
  INPUT_COMMITTED: 1,
  MEMBER_REGISTERED: 2,
  ROUND_CLOSED: 3,
  ROUND_OPENED: 4,
  KEY_PUBLISHED: 5,
} as const

/** First word of every message exchanged with L1 (`CRISPRemoteMessages`). */
export const MESSAGE_KIND = { ROUND: 1n, KEY: 2n, ROOT: 3n, MEMBER: 4n } as const

/**
 * Aztec secret hash of secret `0`, the one every L1 message carries. The contract consumes with secret 0 and
 * the message content authenticates it. Equals `CRISPAztecProgram.SECRET_HASH`.
 */
export const SECRET_HASH = '0x1f8eff65d91ed781c2e7a28a2ff99b7f7506b7293121b5ffcf3cd339c84d2250' as const
