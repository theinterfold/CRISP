// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

// Entry point of `@crisp-e3/sdk/chain`: the chain reads that need nothing but viem. It must never
// import a module that reaches wasm, noir or bb.js, so a page that only shows round status can load
// it without paying for any of them. Anything that recomputes a BFV commitment belongs in the main
// entry.

export { getPublicClient } from './chain'
export { blockAtTimestamp, scanLogs } from './logs'
export {
  MAX_COMMITTEE_KEY_CANDIDATES,
  ROUND_STAGES,
  getCommitteePublicKeyCandidates,
  getInputStartBlock,
  getRoundBfvParams,
  getRoundState,
  getSlotStatus,
} from './round'

export type { ScanLogsParams } from './logs'
export type {
  ChainReadOptions,
  CommitteePublicKeyCandidate,
  RoundBfvParams,
  RoundReadOptions,
  RoundStage,
  RoundState,
  SlotStatus,
} from './round'
