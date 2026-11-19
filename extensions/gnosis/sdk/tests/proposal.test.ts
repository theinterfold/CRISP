// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { decodeAbiParameters, keccak256 } from 'viem'
import { describe, expect, it } from 'vitest'

import { encodeCustomParams, packBatch } from '../src/proposal'

const A = '0x1111111111111111111111111111111111111111'
const B = '0x2222222222222222222222222222222222222222'

describe('packBatch', () => {
  it('packs one call as operation ‖ to ‖ value ‖ dataLength ‖ data', () => {
    const { packed, proposalHash } = packBatch([{ to: A, value: 5n, data: '0xdeadbeef' }])
    expect(packed).toBe(
      `0x00${A.slice(2)}${'5'.padStart(64, '0')}${'4'.padStart(64, '0')}deadbeef`,
    )
    expect(proposalHash).toBe(keccak256(packed))
  })

  it('concatenates calls without padding, and a call without data has length 0', () => {
    const { packed } = packBatch([{ to: A, data: '0x01' }, { to: B }])
    const first = `00${A.slice(2)}${'0'.padStart(64, '0')}${'1'.padStart(64, '0')}01`
    const second = `00${B.slice(2)}${'0'.padStart(64, '0')}${'0'.padStart(64, '0')}`
    expect(packed).toBe(`0x${first}${second}`)
  })

  it('binds the order of the calls', () => {
    const ab = packBatch([{ to: A }, { to: B }]).proposalHash
    const ba = packBatch([{ to: B }, { to: A }]).proposalHash
    expect(ab).not.toBe(ba)
  })

  it('refuses an empty batch', () => {
    expect(() => packBatch([])).toThrow('at least one call')
  })
})

describe('encodeCustomParams', () => {
  const proposalHash = keccak256('0x01')

  it('encodes (0, 0, 0, proposalHash, cid)', () => {
    const encoded = encodeCustomParams({ proposalHash, metadataCid: 'bafy-cid' })
    const [mode, root, total, hash, cid] = decodeAbiParameters(
      [{ type: 'uint8' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'string' }],
      encoded,
    )
    expect([mode, BigInt(root), total, hash, cid]).toEqual([0, 0n, 0n, proposalHash, 'bafy-cid'])
  })

  it('applies the rules Sepolia enforces before it takes a fee', () => {
    expect(() => encodeCustomParams({ proposalHash, metadataCid: '' })).toThrow('1 to 128')
    expect(() => encodeCustomParams({ proposalHash, metadataCid: 'x'.repeat(129) })).toThrow('1 to 128')
    expect(() => encodeCustomParams({ proposalHash: `0x${'0'.repeat(64)}`, metadataCid: 'cid' })).toThrow('zero')
  })
})
