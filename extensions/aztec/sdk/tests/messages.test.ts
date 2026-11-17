// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import {
  encodeKeyMessage,
  encodeRootMessage,
  encodeRoundMessage,
  e3IdOf,
  keyContent,
  rootContent,
  roundContent,
  roundIdOf,
  scopeHashOf,
  scopeOf,
  sha256ToField,
} from '../src/messages'
import { SECRET_HASH } from '../src/constants'
import { Fr } from '@aztec-labs/foundation/curves/bn254'
import { computeSecretHash } from '@aztec-labs/stdlib/hash'

// Produced by the L1 suite (`extensions/aztec/l1`) from the Solidity encoders: the same bytes the L2 contract hashes.
const vectors = JSON.parse(readFileSync(new URL('../../l1/tests/fixtures/message-vectors.json', import.meta.url), 'utf8'))

describe('L1 message vectors', () => {
  it('encodes and hashes the ROUND message like CRISPRemoteMessages.round', () => {
    const f = vectors.round.fields
    const config = {
      roundId: BigInt(f.roundId),
      numOptions: BigInt(f.numOptions),
      credits: BigInt(f.credits),
      inputStart: BigInt(f.inputStart),
      inputEnd: BigInt(f.inputEnd),
      inputLimit: BigInt(f.inputLimit),
      scopeHash: BigInt(f.scopeHash),
      minAge: BigInt(f.minAge),
      allowMockDocuments: f.allowMockDocuments,
    }
    expect(encodeRoundMessage(config)).toBe(vectors.round.abiEncoded)
    expect(roundContent(config)).toBe(BigInt(vectors.round.contentDecimal))
  })

  it('encodes and hashes the KEY message like CRISPRemoteMessages.committeeKey', () => {
    const { roundId, committeePublicKey } = vectors.key.fields
    expect(encodeKeyMessage(BigInt(roundId), committeePublicKey)).toBe(vectors.key.abiEncoded)
    expect(keyContent(BigInt(roundId), committeePublicKey)).toBe(BigInt(vectors.key.contentDecimal))
  })

  it('encodes and hashes the ROOT message like CRISPRemoteMessages.inputRoot', () => {
    const { roundId, inputRoot, numInputs } = vectors.root.fields
    expect(encodeRootMessage(BigInt(roundId), BigInt(inputRoot), BigInt(numInputs))).toBe(vectors.root.abiEncoded)
    expect(rootContent(BigInt(roundId), BigInt(inputRoot), BigInt(numInputs))).toBe(BigInt(vectors.root.contentDecimal))
  })

  it('splits an e3Id into the interfold and the round id the messages carry', () => {
    const { interfold, e3Id, roundId } = vectors.ids
    expect(roundIdOf(BigInt(e3Id))).toBe(BigInt(roundId))
    expect(e3IdOf(interfold, BigInt(roundId))).toBe(BigInt(e3Id))
    expect(() => e3IdOf(interfold, 1n << 96n)).toThrow(/96 bits/)
  })

  it('derives the scope string and hash like CRISPAztecProgram', () => {
    const { chainId, program, e3Id } = vectors.scope
    expect(scopeOf(chainId, program, BigInt(e3Id))).toBe(vectors.scope.string)
    expect(scopeHashOf(chainId, program, BigInt(e3Id))).toBe(BigInt(vectors.scope.hashDecimal))
  })

  it('keeps a message content inside the field', () => {
    expect(sha256ToField('0x00') < 1n << 248n).toBe(true)
  })

  it('uses the secret hash of secret 0 that the L1 program sends with every message', async () => {
    expect(SECRET_HASH).toBe(vectors.secretHash.value)
    expect((await computeSecretHash(Fr.ZERO)).toString()).toBe(SECRET_HASH)
  })
})
