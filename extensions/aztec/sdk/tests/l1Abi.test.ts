// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { readFileSync } from 'node:fs'
import { formatAbiItem } from 'viem/utils'
import type { Abi } from 'viem'
import { describe, expect, it } from 'vitest'

import { programAbi } from '../src/l1'

// The ABI the L1 package exports from its compiled `CRISPAztecProgram`.
const compiled: Abi = JSON.parse(readFileSync(new URL('../../l1/abi/CRISPAztecProgram.json', import.meta.url), 'utf8'))

describe('program ABI subset', () => {
  it.each(programAbi.map((item) => [item.type, 'name' in item ? item.name : '', item] as const))(
    '%s %s matches the compiled program',
    (_type, _name, item) => {
      const match = compiled.find(
        (candidate) => candidate.type === item.type && 'name' in candidate && 'name' in item && candidate.name === item.name,
      )
      expect(match, 'the item is missing from the compiled ABI').toBeDefined()
      expect(formatAbiItem(match!)).toBe(formatAbiItem(item))
    },
  )
})
