// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { PROOF_FIELDS, VK_FIELDS } from '@zkpassport/aztec'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { assembleProofCapsule, outerPublicInputCount } from '../src/zkpassport'

// The real outer_count_5 proof of circuits release 0.23.0 the contract's TXE tests use, as the Noir library vendors it.
const fixture = readFileSync(new URL('../../contracts/vendor/zkpassport/core/src/fixtures/proof.nr', import.meta.url), 'utf8')
const blob = (fixture.match(/AGE_FIXTURE_BLOB: \[Field; \d+\] = \[([^\]]*)\]/)?.[1].match(/0x[0-9a-f]{64}/g) ?? []).map((field) => field.slice(2))

// The SDK emits bare hex.
const parts = (publicInputs: string[] = blob.slice(VK_FIELDS + PROOF_FIELDS)) => ({
  vk: blob.slice(0, VK_FIELDS),
  proof: blob.slice(VK_FIELDS, VK_FIELDS + PROOF_FIELDS),
  publicInputs,
})

describe('ZKPassport proof capsule (circuits 0.23.0)', () => {
  it('counts K + 6 public inputs: K + 5 and the verification method', () => {
    expect([4, 5, 6].map((k) => outerPublicInputCount(k as 4 | 5 | 6))).toEqual([10, 11, 12])
    expect(blob.length).toBe(VK_FIELDS + PROOF_FIELDS + outerPublicInputCount(5))
  })

  it('assembles vk ‖ proof ‖ public inputs, the verification method last', () => {
    const fields = assembleProofCapsule(parts(), 5)

    expect(fields.length).toBe(blob.length)
    expect(fields.map((field) => field.toBigInt())).toEqual(blob.map((field) => BigInt(`0x${field}`)))
    expect(fields.at(-1)?.toBigInt()).toBe(100n)
  })

  it('refuses a proof of circuits 0.22.0, one public input short', () => {
    expect(() => assembleProofCapsule(parts(parts().publicInputs.slice(0, -1)), 5)).toThrow(/public inputs 10\/11/)
  })

  it('refuses a mismatched subproof count', () => {
    expect(() => assembleProofCapsule(parts(), 4)).toThrow(/outer_count_4/)
  })
})
