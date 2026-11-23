// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { generateMerkleTree } from '@crisp-e3/sdk'
import type { LeanIMT } from '@zk-kit/lean-imt'

import type { MemberRegistered, StagingKeyBound } from './logs'

/** The census of one round: the members the contract registered, in registration order. */
export type Census = {
  /** Census leaves `hash_2([slot, credits])`, indexed by registration order. */
  leaves: bigint[]
  /** Root after the last registration; the root a ballot proves membership against. */
  root: bigint
  tree: LeanIMT
}

/**
 * Rebuild the census tree from the round's MEMBER_REGISTERED logs.
 *
 * The contract's tree is the zk-kit LeanIMT over circom PoseidonT3 that `@crisp-e3/sdk` and the fold
 * circuit use, so the rebuilt root is the one the circuit checks. Every log carries the root it produced, which
 * is how a gap, a reorder or a log from another round is caught here instead of as a rejected proof.
 */
export const censusFromLogs = (logs: readonly MemberRegistered[]): Census =>
  rebuildTree(
    'Census',
    logs.map((log) => ({ index: log.censusIndex, leaf: log.censusLeaf, root: log.censusRoot })),
  )

/**
 * Rebuild a round's staging tree (`crisp_aztec_votes`) from its STAGING_KEY_BOUND logs. The tree is the census tree's kind: the
 * leaves are the slots' staging commitments, which a staging pass proves membership of. Returned as a {@link Census}.
 */
export const stagingTreeFromLogs = (logs: readonly StagingKeyBound[]): Census =>
  rebuildTree(
    'Staging tree',
    logs.map((log) => ({ index: log.index, leaf: log.commitment, root: log.root })),
  )

const rebuildTree = (what: string, entries: readonly { index: number; leaf: bigint; root: bigint }[]): Census => {
  const sorted = [...entries].sort((a, b) => a.index - b.index)
  sorted.forEach((entry, i) => {
    if (entry.index !== i) throw new Error(`${what} log ${i} is missing: found index ${entry.index}`)
  })
  const leaves = sorted.map((entry) => entry.leaf)
  const tree = generateMerkleTree(leaves)
  const last = sorted.at(-1)
  if (last && last.root !== tree.root) {
    throw new Error(`Rebuilt ${what.toLowerCase()} root ${tree.root} differs from the root the contract logged for entry ${last.index}`)
  }

  return { leaves, root: tree.root ?? 0n, tree }
}
