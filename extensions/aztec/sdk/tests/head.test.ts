// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { bytesToHex, getAddress, keccak256, type Address } from 'viem'
import { describe, expect, it, vi } from 'vitest'

import { ciphertextStore, resolveSlotHead } from '../src/head'
import type { InputCommitted } from '../src/logs'
import { e3IdOf } from '../src/messages'

const INTERFOLD = getAddress('0xdFa59d66c173A00643eBE80e172Af5a8Cf244b30')
const E3_ID = e3IdOf(INTERFOLD, 7n)
const SLOT: Address = getAddress('0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266')
const OTHER: Address = getAddress('0x70997970c51812dc3a010c7d01b50e0d17dc79c8')

const bytes = (fill: number) => new Uint8Array(32).fill(fill)

const input = (index: number, slot: Address, ciphertext: Uint8Array, parentIndexPlusOne: number): InputCommitted => ({
  kind: 'InputCommitted',
  e3Id: E3_ID,
  roundId: 7n,
  index,
  slot,
  ctCommitment: '0x00',
  encryptedVoteHash: keccak256(bytesToHex(ciphertext)),
  parentIndexPlusOne,
})

const clientOf = (logs: InputCommitted[]) => ({ logs: async () => logs }) as never

const memory = () => {
  const data = new Map<string, string>()
  return ciphertextStore({ get: (key) => data.get(key), set: (key, value) => void data.set(key, value) })
}

describe('resolveSlotHead', () => {
  const first = bytes(1)
  const second = bytes(2)
  // Slot's chain: input 0, then input 2 naming 0 as parent; another slot's input 1 sits between them.
  const logs = [input(0, SLOT, first, 0), input(1, OTHER, bytes(9), 0), input(2, SLOT, second, 1)]
  const fetchServerHead = vi.fn()

  it('is undefined for a slot without inputs', async () => {
    expect(await resolveSlotHead({ client: clientOf([input(1, OTHER, bytes(9), 0)]), e3Id: E3_ID, slot: SLOT, serverUrl: 'http://x', fetchServerHead })).toBeUndefined()
  })

  it('picks the latest input of the slot, not the first and not another slot', async () => {
    const cache = memory()
    await cache.set(E3_ID, first)
    await cache.set(E3_ID, second)
    const head = await resolveSlotHead({ client: clientOf(logs), e3Id: E3_ID, slot: SLOT, cache, serverUrl: 'http://x', fetchServerHead })
    expect(head).toEqual({ ciphertext: second, index: 2 })
  })

  it('takes the bytes from the cache without asking the server', async () => {
    fetchServerHead.mockClear()
    const cache = memory()
    await cache.set(E3_ID, second)
    await resolveSlotHead({ client: clientOf(logs), e3Id: E3_ID, slot: SLOT, cache, serverUrl: 'http://x', fetchServerHead })
    expect(fetchServerHead).not.toHaveBeenCalled()
  })

  it('falls back to the server when the cache lacks the head, or holds other bytes', async () => {
    fetchServerHead.mockResolvedValue({ ciphertext: second, index: 2 })
    expect(await resolveSlotHead({ client: clientOf(logs), e3Id: E3_ID, slot: SLOT, cache: memory(), serverUrl: 'http://x', fetchServerHead })).toEqual({
      ciphertext: second,
      index: 2,
    })

    // A cache entry that does not hash to the logged value is ignored.
    const corrupt = ciphertextStore({ get: () => bytesToHex(bytes(7)), set: () => undefined })
    expect(await resolveSlotHead({ client: clientOf(logs), e3Id: E3_ID, slot: SLOT, cache: corrupt, serverUrl: 'http://x', fetchServerHead })).toEqual({
      ciphertext: second,
      index: 2,
    })
  })

  it('throws, rather than treat the slot as empty, when no source has the head', async () => {
    fetchServerHead.mockResolvedValue(undefined)
    await expect(resolveSlotHead({ client: clientOf(logs), e3Id: E3_ID, slot: SLOT, serverUrl: 'http://x', fetchServerHead })).rejects.toThrow(/latest ballot/)
    // A stale server head (the previous input) is not the head either.
    fetchServerHead.mockResolvedValue({ ciphertext: first, index: 0 })
    await expect(resolveSlotHead({ client: clientOf(logs), e3Id: E3_ID, slot: SLOT, serverUrl: 'http://x', fetchServerHead })).rejects.toThrow(/latest ballot/)
  })
})
