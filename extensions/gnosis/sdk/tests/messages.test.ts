// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import {
  decodeKeyMessage,
  decodeResultMessage,
  decodeRootMessage,
  decodeRoundMessage,
  e3IdOf,
  encodeKeyMessage,
  encodeReceiveMessage,
  encodeResultMessage,
  encodeRootMessage,
  encodeRoundMessage,
  roundIdOf,
  type RoundMessage,
} from '../src/messages'

// Written by the Foundry suite (`extensions/gnosis/contracts`) from the Solidity encoders: the same bytes the contracts hash and decode.
const vectors = JSON.parse(readFileSync(new URL('../../contracts/test/fixtures/message-vectors.json', import.meta.url), 'utf8'))

const roundMessage = (f: Record<string, string>): RoundMessage => ({
  roundId: BigInt(f.roundId),
  numOptions: BigInt(f.numOptions),
  inputStart: BigInt(f.inputStart),
  inputEnd: BigInt(f.inputEnd),
  inputLimit: BigInt(f.inputLimit),
  plaintextModulus: BigInt(f.plaintextModulus),
  snapshot: BigInt(f.snapshot),
  censusMode: BigInt(f.censusMode),
  censusRoot: f.censusRoot as `0x${string}`,
  censusTotal: BigInt(f.censusTotal),
  proposalHash: f.proposalHash as `0x${string}`,
  requester: f.requester as `0x${string}`,
  metadataCid: f.metadataCid,
})

describe('Solidity message vectors', () => {
  it('encodes and decodes the 14-word ROUND message like CRISPGnosisMessages.round', () => {
    const message = roundMessage(vectors.round.fields)
    expect(encodeRoundMessage(message)).toBe(vectors.round.abiEncoded)
    expect(decodeRoundMessage(vectors.round.abiEncoded)).toEqual(message)
  })

  it('encodes and decodes the KEY message like CRISPRemoteMessages.committeeKey', () => {
    const { roundId, committeePublicKey } = vectors.key.fields
    expect(encodeKeyMessage(BigInt(roundId), committeePublicKey)).toBe(vectors.key.abiEncoded)
    expect(decodeKeyMessage(vectors.key.abiEncoded)).toEqual({ roundId: BigInt(roundId), committeePublicKey })
  })

  it('encodes and decodes the ROOT message like CRISPRemoteMessages.inputRoot', () => {
    const { roundId, root, numInputs } = vectors.root.fields
    expect(encodeRootMessage(BigInt(roundId), BigInt(root), BigInt(numInputs))).toBe(vectors.root.abiEncoded)
    expect(decodeRootMessage(vectors.root.abiEncoded)).toEqual({ roundId: BigInt(roundId), inputRoot: BigInt(root), numInputs: BigInt(numInputs) })
  })

  it('encodes and decodes the RESULT message like CRISPGnosisMessages.result', () => {
    const { roundId, tally } = vectors.result.fields
    const expected = (tally as string[]).map(BigInt)
    expect(encodeResultMessage(BigInt(roundId), expected)).toBe(vectors.result.abiEncoded)
    expect(decodeResultMessage(vectors.result.abiEncoded)).toEqual({ roundId: BigInt(roundId), tally: expected })
  })
})

describe('message kinds', () => {
  it('refuses to decode a message of another kind', () => {
    expect(() => decodeKeyMessage(encodeRootMessage(1n, 2n, 3n))).toThrow('kind')
    expect(() => decodeKeyMessage(encodeResultMessage(1n, [1n, 2n, 3n]))).toThrow('kind')
  })

  it('wraps a message as receiveMessage(bytes) calldata', () => {
    const message = encodeRootMessage(1n, 2n, 3n)
    expect(encodeReceiveMessage(message).startsWith('0x')).toBe(true)
    expect(encodeReceiveMessage(message)).toContain(message.slice(2))
  })
})

describe('round ids', () => {
  const interfold = '0xb35EE9ed8BE5967daabBA8c2e817C52D0b57ac26'

  it('keeps the low 96 bits of an e3Id and rebuilds it for its Interfold', () => {
    const e3Id = e3IdOf(interfold, 42n)
    expect(roundIdOf(e3Id)).toBe(42n)
    expect(e3Id >> 96n).toBe(BigInt(interfold))
    expect(() => e3IdOf(interfold, 1n << 96n)).toThrow('96 bits')
  })
})
