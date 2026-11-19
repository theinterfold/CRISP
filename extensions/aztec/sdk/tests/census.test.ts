// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { generateMerkleProof, generateMerkleTree, hashLeaf } from '@crisp-e3/sdk'
import { LeanIMT } from '@zk-kit/lean-imt'
import { poseidon2 } from 'poseidon-lite'
import { getAddress, numberToHex, type Address } from 'viem'
import { describe, expect, it } from 'vitest'

import { censusFromLogs } from '../src/census'
import type { MemberRegistered } from '../src/logs'

const CREDITS = 100n
const slots: Address[] = Array.from({ length: 6 }, (_, i) => getAddress(numberToHex(0x1000n + BigInt(i), { size: 20 })))

/** The logs the contract would emit: each carries the root after its own insertion. */
const logsFor = (members: Address[]): MemberRegistered[] =>
  members.map((slot, i) => {
    const leaves = members.slice(0, i + 1).map((s) => hashLeaf(s, CREDITS))
    return {
      kind: 'MemberRegistered',
      e3Id: 7n,
      roundId: 7n,
      censusIndex: i,
      slot,
      censusLeaf: leaves[i],
      censusRoot: generateMerkleTree(leaves).root,
    }
  })

describe('census from logs', () => {
  it('rebuilds the tree the fold circuit checks, whatever order the logs arrive in', () => {
    const logs = logsFor(slots)
    const census = censusFromLogs([...logs].reverse())

    expect(census.leaves).toEqual(slots.map((s) => hashLeaf(s, CREDITS)))
    expect(census.root).toBe(logs.at(-1)!.censusRoot)
    expect(census.root).toBe(new LeanIMT((a, b) => poseidon2([a, b]), census.leaves).root)
  })

  it('gives each member a path to the root with crisp-sdk, as the circuit expects', () => {
    const census = censusFromLogs(logsFor(slots))
    for (const slot of slots) {
      const proof = generateMerkleProof(CREDITS, slot, census.leaves)
      // The circuit hashes the leaf up `length` levels, left or right by `indices`; the padding beyond is ignored.
      const root = proof.proof.siblings
        .slice(0, proof.length)
        .reduce(
          (node, sibling, level) => (proof.indices[level] === 0 ? poseidon2([node, sibling]) : poseidon2([sibling, node])),
          proof.leaf,
        )
      expect(root).toBe(census.root)
    }
  })

  it('catches a missing registration and a root that does not follow from the leaves', () => {
    const logs = logsFor(slots)
    expect(() => censusFromLogs([logs[0], logs[2]])).toThrow(/missing/)
    expect(() => censusFromLogs([logs[0], { ...logs[1], censusRoot: 1n }])).toThrow(/differs/)
  })
})
