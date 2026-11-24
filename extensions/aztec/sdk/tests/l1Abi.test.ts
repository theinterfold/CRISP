// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { readFileSync } from 'node:fs'
import { formatAbiItem } from 'viem/utils'
import type { Abi } from 'viem'
import { describe, expect, it } from 'vitest'

import { programAbi, votesProgramAbi } from '../src/l1'

// The ABI the L1 package exports from its compiled `CRISPAztecProgram`.
const abiOf = (name: string): Abi => JSON.parse(readFileSync(new URL(`../../l1/abi/${name}.json`, import.meta.url), 'utf8'))

const matchesCompiled = (name: string, subset: Abi) =>
  it.each(subset.filter((item) => item.type === 'function' || item.type === 'event').map((item) => [item.type, 'name' in item ? item.name : '', item] as const))(
    `%s %s matches the compiled ${name}`,
    (_type, _name, item) => {
      const match = abiOf(name).find(
        (candidate) => candidate.type === item.type && 'name' in candidate && 'name' in item && candidate.name === item.name,
      )
      expect(match, 'the item is missing from the compiled ABI').toBeDefined()
      expect(formatAbiItem(match!)).toBe(formatAbiItem(item))
    },
  )

describe('program ABI subset', () => matchesCompiled('CRISPAztecProgram', programAbi as Abi))

describe('votes program ABI subset', () => matchesCompiled('CRISPAztecVotesProgram', [...programAbi, ...votesProgramAbi] as Abi))
