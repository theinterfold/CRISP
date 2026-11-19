// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { readFileSync } from 'node:fs'
import { keccak256, type Address, type Hex } from 'viem'
import { describe, expect, it } from 'vitest'

import { inputLeaf } from '../src/ballot'
import { inputTreeRoot } from '../src/inputTree'

// Roots recorded from the Solidity `InternalLazyIMT` by the L1 CRISP suite, over real ballots; the Rust input tree
// is asserted against the same files, so agreeing here puts all three implementations on one tree.
type Fixture = {
  inputRoot: Hex
  contractLeaf?: string
  inputs: { encryptedVote: Hex; commitment: Hex; slot: Address; parentIndexPlusOne: string }[]
}
const fixture = (name: string): Fixture =>
  JSON.parse(readFileSync(new URL(`../../../../packages/crisp-contracts/tests/fixtures/${name}`, import.meta.url), 'utf8'))

const leavesOf = (f: Fixture) =>
  f.inputs.map((input) =>
    inputLeaf({
      encryptedVoteHash: keccak256(input.encryptedVote),
      commitment: input.commitment,
      slot: input.slot,
      parentIndexPlusOne: Number(input.parentIndexPlusOne),
    }),
  )

describe('input tree', () => {
  it.each(['input-tree.json', 'input-tree-append.json', 'input-tree-revote.json'])(
    'reproduces the on-chain leaves and root of %s',
    (name) => {
      const f = fixture(name)
      const leaves = leavesOf(f)
      if (f.contractLeaf) expect(leaves[0]).toBe(BigInt(f.contractLeaf))
      expect(inputTreeRoot(leaves)).toBe(BigInt(f.inputRoot))
    },
  )

  it('gives an empty round the root crisp_aztec reported when it closed one with no inputs', () => {
    // Observed in the RoundClosed log of the real contract on a local Aztec network (v6.0.0).
    expect(inputTreeRoot([])).toBe(14744269619966411208579211824598458697587494354926760081771325075741142829156n)
  })

  it('refuses more leaves than a round may hold', () => {
    expect(() => inputTreeRoot(new Array(65_537).fill(1n))).toThrow(/at most 65536/)
  })
})
