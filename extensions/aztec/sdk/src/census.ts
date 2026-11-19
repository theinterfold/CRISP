// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { generateMerkleTree } from '@crisp-e3/sdk'
import type { LeanIMT } from '@zk-kit/lean-imt'

import type { MemberRegistered } from './logs'

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
export const censusFromLogs = (logs: readonly MemberRegistered[]): Census => {
  const sorted = [...logs].sort((a, b) => a.censusIndex - b.censusIndex)
  sorted.forEach((log, i) => {
    if (log.censusIndex !== i) throw new Error(`Census log ${i} is missing: found index ${log.censusIndex}`)
  })
  const leaves = sorted.map((log) => log.censusLeaf)
  const tree = generateMerkleTree(leaves)
  const last = sorted.at(-1)
  if (last && last.censusRoot !== tree.root) {
    throw new Error(`Rebuilt census root ${tree.root} differs from the root the contract logged for member ${last.censusIndex}`)
  }

  return { leaves, root: tree.root ?? 0n, tree }
}
