// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { getAddress, hexToBytes, keccak256, pad, toHex } from 'viem'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { getSlotHead } from '../src/slotHead'
import type { DaEntry, DaReader } from '../src/da'

const { getLogs, getInputStartBlock } = vi.hoisted(() => ({ getLogs: vi.fn(), getInputStartBlock: vi.fn() }))

vi.mock('../src/chain', () => ({
  getPublicClient: () => ({ getLogs, getBlockNumber: async () => 1000n }),
}))
vi.mock('../src/round', () => ({ getInputStartBlock }))

// A stand-in for the BFV commitment: any deterministic function of the bytes works, and bytes
// starting with 0xff stand for "does not deserialize".
const commitmentOf = (bytes: Uint8Array) => {
  if (bytes[0] === 0xff) throw new Error('not a ciphertext')
  return hexToBytes(keccak256(Uint8Array.from([1, ...bytes])))
}
vi.mock('../src/encoding', () => ({
  getZkInputsGenerator: () => ({ computeCtCommitment: (bytes: Uint8Array) => commitmentOf(bytes) }),
}))

const E3_ID = 7n
const SLOT = getAddress('0x00000000000000000000000000000000000000aa')
const OTHER = getAddress('0x00000000000000000000000000000000000000bb')
const PROGRAM = '0x00000000000000000000000000000000000000cc'

type Chain = { slot?: string; tag: number; parent: number | null; poisoned?: boolean; published?: boolean }

const ciphertextOf = (tag: number, poisoned = false) =>
  Uint8Array.from([poisoned ? 0xff : 0, tag, ...Array.from({ length: 30 }, (_, i) => i)])

/** Lays a table of entries (tree index = position) out as chain events and a byte store. */
const scenario = (chain: Chain[]) => {
  const store = new Map<string, Uint8Array>()
  type Log = { args: { slotAddress: string } & Record<string, unknown> }
  const committed: Log[] = []
  const published: Log[] = []

  chain.forEach((entry, index) => {
    const bytes = ciphertextOf(entry.tag, entry.poisoned)
    const hash = keccak256(bytes)
    store.set(hash, bytes)

    // A poisoned entry commits to something its bytes do not reproduce.
    const commitment = entry.poisoned ? pad(toHex(entry.tag)) : toHex(commitmentOf(ciphertextOf(entry.tag)))
    const base = {
      slotAddress: entry.slot ?? SLOT,
      encryptedVoteCommitment: commitment,
      encryptedVoteHash: hash,
      parentIndexPlusOne: entry.parent === null ? 0 : entry.parent + 1,
    }

    committed.push({ args: { ...base, e3Id: E3_ID, index } })
    if (entry.published !== false) {
      published.push({
        args: { ...base, e3Id: E3_ID, index: BigInt(index), availabilityBlock: 100 + index, availabilityLeafIndex: BigInt(index) },
      })
    }
  })

  getLogs.mockImplementation(async ({ event, args }: { event: { name: string }; args: { slotAddress: string } }) =>
    (event.name === 'InputCommitted' ? committed : published).filter((log) => log.args.slotAddress === args.slotAddress),
  )

  const read = vi.fn(async (entry: DaEntry) => {
    const bytes = store.get(entry.encryptedVoteHash)
    if (!bytes) throw new Error('not stored')
    return bytes
  })

  return { read, daReader: { read } satisfies DaReader }
}

const head = (daReader: DaReader, extra: object = {}) =>
  getSlotHead({ programAddress: PROGRAM, e3Id: E3_ID, slot: SLOT.toLowerCase(), chainId: 11155111, daReader, fromBlock: 0n, ...extra })

describe('getSlotHead', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('is undefined for a slot with no entries', async () => {
    const { daReader, read } = scenario([])

    expect(await head(daReader)).toBeUndefined()
    expect(read).not.toHaveBeenCalled()
  })

  it('returns the end of the chain with its tree index', async () => {
    const { daReader } = scenario([
      { tag: 1, parent: null },
      { tag: 2, parent: 0 },
      { tag: 3, parent: 1 },
    ])

    expect(await head(daReader)).toEqual({ ciphertext: ciphertextOf(3), index: 2 })
  })

  it('uses the tree index across slots, not the position within the slot', async () => {
    const { daReader } = scenario([
      { slot: OTHER, tag: 1, parent: null },
      { tag: 2, parent: null },
      { slot: OTHER, tag: 3, parent: 0 },
      { tag: 4, parent: 1 },
    ])

    expect(await head(daReader)).toEqual({ ciphertext: ciphertextOf(4), index: 3 })
  })

  it('skips an entry whose bytes do not reproduce its commitment', async () => {
    const { daReader } = scenario([
      { tag: 1, parent: null },
      { tag: 2, parent: 0, poisoned: true },
    ])

    expect(await head(daReader)).toEqual({ ciphertext: ciphertextOf(1), index: 0 })
  })

  it('takes the next honest entry that names the unchanged head', async () => {
    const { daReader } = scenario([
      { tag: 1, parent: null },
      { tag: 2, parent: 0, poisoned: true },
      { tag: 3, parent: 0 },
    ])

    expect(await head(daReader)).toEqual({ ciphertext: ciphertextOf(3), index: 2 })
  })

  it('is undefined when every entry is unusable', async () => {
    const { daReader } = scenario([{ tag: 1, parent: null, poisoned: true }])

    expect(await head(daReader)).toBeUndefined()
  })

  it('keeps the first sibling over a stale mask', async () => {
    const { daReader } = scenario([
      { tag: 1, parent: null },
      { tag: 2, parent: 0 },
      { tag: 3, parent: 0 },
    ])

    expect(await head(daReader)).toEqual({ ciphertext: ciphertextOf(2), index: 1 })
  })

  it('fetches only entries that could become the head', async () => {
    const { daReader, read } = scenario([
      { tag: 1, parent: null },
      { tag: 2, parent: 0 },
      { tag: 3, parent: 0 },
    ])

    await head(daReader)

    expect(read.mock.calls.map(([entry]) => entry.index)).toEqual([0, 1])
  })

  it('hands the reader the availability coordinates of a published entry', async () => {
    const { daReader, read } = scenario([{ tag: 1, parent: null }])

    await head(daReader)

    expect(read).toHaveBeenCalledWith(
      expect.objectContaining({
        e3Id: E3_ID,
        slot: SLOT,
        index: 0,
        availabilityBlock: 100,
        availabilityLeafIndex: 0n,
        encryptedVoteHash: keccak256(ciphertextOf(1)),
      }),
    )
  })

  it('filters the logs by round and slot', async () => {
    const { daReader } = scenario([{ tag: 1, parent: null }])

    await head(daReader)

    expect(getLogs).toHaveBeenCalledTimes(2)
    for (const [query] of getLogs.mock.calls) {
      expect(query).toMatchObject({ address: PROGRAM, args: { e3Id: E3_ID, slotAddress: SLOT }, fromBlock: 0n, toBlock: 1000n })
    }
  })

  it('starts at the input window when no block is given', async () => {
    getInputStartBlock.mockResolvedValue(900n)
    const { daReader } = scenario([{ tag: 1, parent: null }])

    await getSlotHead({ programAddress: PROGRAM, e3Id: E3_ID, slot: SLOT, chainId: 11155111, daReader })

    expect(getInputStartBlock).toHaveBeenCalledWith({ programAddress: PROGRAM, e3Id: E3_ID, chainId: 11155111, rpcUrl: undefined })
    expect(getLogs.mock.calls[0][0]).toMatchObject({ fromBlock: 900n })
  })

  describe('refuses to guess', () => {
    it('rejects bytes that do not hash to the committed value', async () => {
      scenario([{ tag: 1, parent: null }])
      const wrong: DaReader = { read: async () => ciphertextOf(9) }

      await expect(head(wrong)).rejects.toThrow(/Cannot read the ciphertext of entry 0.*hash to/)
    })

    it('rejects when the reader fails', async () => {
      scenario([{ tag: 1, parent: null }])
      const failing: DaReader = { read: async () => Promise.reject(new Error('Avail is down')) }

      await expect(head(failing)).rejects.toThrow('Avail is down')
    })

    it('rejects an entry that is still waiting for its Avail receipt and cannot be read', async () => {
      const { read } = scenario([
        { tag: 1, parent: null },
        { tag: 2, parent: 0, published: false },
      ])
      read.mockImplementation(async (entry) => {
        if (entry.availabilityBlock === undefined) throw new Error('not staged')
        return ciphertextOf(entry.index + 1)
      })

      await expect(head({ read })).rejects.toThrow(/entry 1 \(its availability receipt is not on chain yet\)/)
    })

    it('uses a pending entry when the reader can supply it', async () => {
      const { daReader } = scenario([
        { tag: 1, parent: null },
        { tag: 2, parent: 0, published: false },
      ])

      expect(await head(daReader)).toEqual({ ciphertext: ciphertextOf(2), index: 1 })
    })

    it('rejects events that disagree about an entry', async () => {
      scenario([{ tag: 1, parent: null }])
      getLogs.mockImplementation(async ({ event }: { event: { name: string } }) => [
        {
          args:
            event.name === 'InputCommitted'
              ? { slotAddress: SLOT, encryptedVoteCommitment: pad('0x01'), encryptedVoteHash: pad('0x02'), parentIndexPlusOne: 0, index: 0 }
              : {
                  slotAddress: SLOT,
                  encryptedVoteCommitment: pad('0x01'),
                  encryptedVoteHash: pad('0x03'),
                  parentIndexPlusOne: 0,
                  index: 0n,
                  availabilityBlock: 1,
                  availabilityLeafIndex: 0n,
                },
        },
      ])

      await expect(head({ read: async () => new Uint8Array(1) })).rejects.toThrow('disagree')
    })
  })
})
