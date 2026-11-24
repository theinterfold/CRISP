// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { describe, expect, it } from 'vitest'

import { decodeLog as decode } from '../src/logs'
import { e3IdOf } from '../src/messages'

const INTERFOLD = '0xdFa59d66c173A00643eBE80e172Af5a8Cf244b30'
const E3_ID = e3IdOf(INTERFOLD, 7n)
const decodeLog = (fields: bigint[]) => decode(fields, INTERFOLD)

describe('decodeLog', () => {
  it('decodes STAGING_KEY_BOUND with its slot', () => {
    expect(decodeLog([6n, 7n, 2n, 0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266n, 11n, 12n])).toEqual({
      kind: 'StagingKeyBound',
      e3Id: E3_ID,
      roundId: 7n,
      index: 2,
      slot: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
      commitment: 11n,
      root: 12n,
    })
  })

  it('decodes INPUT_COMMITTED and rebuilds the vote hash from its u128 halves', () => {
    const hi = 0x0102030405060708090a0b0c0d0e0f10n
    const lo = 0x1112131415161718191a1b1c1d1e1f20n
    const log = decodeLog([1n, 7n, 3n, 0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266n, 99n, hi, lo, 2n])
    expect(log).toEqual({
      kind: 'InputCommitted',
      e3Id: E3_ID,
      roundId: 7n,
      index: 3,
      slot: '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266',
      ctCommitment: '0x0000000000000000000000000000000000000000000000000000000000000063',
      encryptedVoteHash: '0x0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20',
      parentIndexPlusOne: 2,
    })
  })

  it('decodes MEMBER_REGISTERED', () => {
    expect(decodeLog([2n, 7n, 0n, 0x70997970c51812dc3a010c7d01b50e0d17dc79c8n, 11n, 12n])).toEqual({
      kind: 'MemberRegistered',
      e3Id: E3_ID,
      roundId: 7n,
      censusIndex: 0,
      slot: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8',
      censusLeaf: 11n,
      censusRoot: 12n,
    })
  })

  it('decodes ROUND_CLOSED, ROUND_OPENED and KEY_PUBLISHED', () => {
    expect(decodeLog([3n, 7n, 5n, 4n])).toEqual({ kind: 'RoundClosed', e3Id: E3_ID, roundId: 7n, inputRoot: 5n, numInputs: 4 })
    expect(decodeLog([4n, 7n])).toEqual({ kind: 'RoundOpened', e3Id: E3_ID, roundId: 7n })
    expect(decodeLog([5n, 7n, 1n])).toEqual({
      kind: 'KeyPublished',
      e3Id: E3_ID,
      roundId: 7n,
      committeePublicKey: '0x0000000000000000000000000000000000000000000000000000000000000001',
    })
  })

  it('rebuilds the full e3Id from the interfold and the logged round id', () => {
    expect(E3_ID).toBe(0xdfa59d66c173a00643ebe80e172af5a8cf244b30000000000000000000000007n)
    expect(decodeLog([4n, 7n])).toMatchObject({ e3Id: E3_ID, roundId: 7n })
  })

  it('rejects an unknown tag and a short log', () => {
    expect(() => decodeLog([9n, 1n])).toThrow(/Unknown/)
    expect(() => decodeLog([3n, 7n])).toThrow(/expected 4/)
  })
})
