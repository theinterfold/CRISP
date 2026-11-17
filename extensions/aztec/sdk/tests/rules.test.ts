// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { readFileSync } from 'node:fs'
import { zeroAddress } from 'viem'
import { describe, expect, it } from 'vitest'

import {
  NATIONALITY_MODE,
  type RoundRules,
  decodeCustomParams,
  encodeCustomParams,
  nationalityCommitment,
  registersOnL1,
  registrationSubproofs,
} from '../src/rules'

// ZKPassport's own conformance anchors, parsed from the vendored Noir library the contract verifies against.
const fixtures = readFileSync(new URL('../../contracts/vendor/zkpassport/core/src/fixtures.nr', import.meta.url), 'utf8')
const anchor = (name: string): bigint => {
  const match = new RegExp(`global ${name}: Field =\\s*(0x[0-9a-f]+)`).exec(fixtures)
  if (!match) throw new Error(`${name} is not in fixtures.nr`)

  return BigInt(match[1] as string)
}

const registrar = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'

const rules = (overrides: Partial<RoundRules> = {}): RoundRules => ({
  numOptions: 3n,
  credits: 100n,
  minAge: 18n,
  allowMockDocuments: true,
  registrar: zeroAddress,
  nationalityMode: NATIONALITY_MODE.NONE,
  countries: [],
  nationalityCommitment: 0n,
  ...overrides,
})

describe('nationalityCommitment', () => {
  it('equals ZKPassport\'s inclusion anchor, keeping the given order', async () => {
    expect(await nationalityCommitment(NATIONALITY_MODE.IN, ['FRA', 'DEU', 'ITA'])).toBe(anchor('NATIONALITY_INCLUSION_COMMITMENT'))
    expect(await nationalityCommitment(NATIONALITY_MODE.IN, ['ITA', 'DEU', 'FRA'])).not.toBe(anchor('NATIONALITY_INCLUSION_COMMITMENT'))
  })

  it('equals ZKPassport\'s exclusion anchor, whatever the order given', async () => {
    const expected = anchor('NATIONALITY_EXCLUSION_COMMITMENT')
    expect(await nationalityCommitment(NATIONALITY_MODE.OUT, ['PRK', 'IRN', 'SYR'])).toBe(expected)
    expect(await nationalityCommitment(NATIONALITY_MODE.OUT, ['SYR', 'PRK', 'IRN'])).toBe(expected)
    expect(await nationalityCommitment(NATIONALITY_MODE.OUT, ['IRN', 'SYR', 'PRK'])).toBe(expected)
  })

  it('refuses lists the L1 program refuses', async () => {
    await expect(nationalityCommitment(NATIONALITY_MODE.IN, [])).rejects.toThrow(/1 to 200/)
    await expect(nationalityCommitment(NATIONALITY_MODE.IN, ['D<<'])).rejects.toThrow(/alpha-3/)
    await expect(nationalityCommitment(NATIONALITY_MODE.IN, ['de'])).rejects.toThrow(/alpha-3/)
    await expect(nationalityCommitment(NATIONALITY_MODE.IN, Array.from({ length: 201 }, () => 'DEU'))).rejects.toThrow(/1 to 200/)
  })
})

describe('custom params', () => {
  it('round-trips an Aztec-path round with a nationality rule', async () => {
    const aztec = rules({ nationalityMode: NATIONALITY_MODE.IN, countries: ['DEU', 'FRA'], nationalityCommitment: await nationalityCommitment(NATIONALITY_MODE.IN, ['DEU', 'FRA']) })
    const decoded = decodeCustomParams(encodeCustomParams(aztec))
    expect(decoded).toEqual(aztec)
    expect(registersOnL1(decoded)).toBe(false)
  })

  it('round-trips an L1-path round', () => {
    const l1 = rules({ registrar, nationalityMode: NATIONALITY_MODE.OUT, countries: ['PRK'] })
    const decoded = decodeCustomParams(encodeCustomParams(l1))
    expect(decoded).toEqual(l1)
    expect(registersOnL1(decoded)).toBe(true)
  })

  it('round-trips a round without a nationality rule', () => {
    expect(decodeCustomParams(encodeCustomParams(rules()))).toEqual(rules())
  })

  it('encodes in the layout the L1 program decodes', () => {
    // abi.encode(uint256 numOptions, uint256 credits, uint256 minAge, bool allowMock, address registrar, uint8 mode, string[] countries, uint256 commitment)
    const encoded = encodeCustomParams(rules())
    const word = (i: number) => BigInt(`0x${encoded.slice(2 + i * 64, 2 + (i + 1) * 64)}`)
    expect([word(0), word(1), word(2), word(3), word(4), word(5)]).toEqual([3n, 100n, 18n, 1n, 0n, 0n])
    expect(word(6)).toBe(8n * 32n) // the offset of the string[]: eight head words
    expect(word(7)).toBe(0n) // the commitment
    expect(word(8)).toBe(0n) // the empty list's length
  })

  it('refuses rules the program refuses', () => {
    expect(() => encodeCustomParams(rules({ minAge: 100n }))).toThrow(/minimum age/)
    expect(() => encodeCustomParams(rules({ countries: ['DEU'] }))).toThrow(/without a nationality rule/)
    expect(() => encodeCustomParams(rules({ nationalityMode: NATIONALITY_MODE.IN, countries: [] }))).toThrow(/1 to 200/)
    expect(() => encodeCustomParams(rules({ nationalityMode: NATIONALITY_MODE.IN, countries: ['DEU'] }))).toThrow(/needs the list commitment/)
    expect(() => encodeCustomParams(rules({ registrar, nationalityMode: NATIONALITY_MODE.IN, countries: ['DEU'], nationalityCommitment: 1n }))).toThrow(/carries no nationality commitment/)
  })
})

describe('registrationSubproofs', () => {
  it('sizes the outer proof by the rules of the round', () => {
    expect(registrationSubproofs({ minAge: 0n, nationalityMode: 0 })).toBe(4)
    expect(registrationSubproofs({ minAge: 18n, nationalityMode: 0 })).toBe(5)
    expect(registrationSubproofs({ minAge: 0n, nationalityMode: 1 })).toBe(5)
    expect(registrationSubproofs({ minAge: 18n, nationalityMode: 2 })).toBe(6)
  })
})
