// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { bytesToHex, keccak256 } from 'viem'
import { describe, expect, it, vi } from 'vitest'

import { createAvailDaReader, createFallbackDaReader, createHttpDaReader, readVerified } from '../src/da'
import type { DaEntry, DaReader } from '../src/da'

const bytes = (length: number, seed = 1) => Uint8Array.from({ length }, (_, i) => (i * 7 + seed) % 256)

const entryFor = (data: Uint8Array, extra: Partial<DaEntry> = {}): DaEntry => ({
  e3Id: 1n,
  slot: '0x00000000000000000000000000000000000000aa',
  index: 3,
  encryptedVoteHash: keccak256(data),
  availabilityBlock: 42,
  availabilityLeafIndex: 0n,
  ...extra,
})

/** SCALE compact encoding of a length, as it precedes a `Vec<u8>`. */
const compact = (length: number): number[] => {
  if (length < 1 << 6) return [length << 2]
  if (length < 1 << 14) return [((length << 2) | 1) & 0xff, (length << 2) >> 8]
  return [((length << 2) | 2) & 0xff, ((length << 2) >> 8) & 0xff, ((length << 2) >> 16) & 0xff, ((length << 2) >>> 24) & 0xff]
}

/** An extrinsic shaped like a signed `submit_data`: some header, the call ids, then the data. */
const extrinsicOf = (data: Uint8Array, header = 90): `0x${string}` =>
  bytesToHex(Uint8Array.from([...bytes(header, 9), 29, 1, ...compact(data.length), ...data]))

describe('readVerified', () => {
  it('returns bytes that hash to the committed value', async () => {
    const data = bytes(64)
    const reader: DaReader = { read: async () => data }

    expect(await readVerified(reader, entryFor(data))).toEqual(data)
  })

  it('rejects bytes that do not hash to the committed value', async () => {
    const data = bytes(64)
    const reader: DaReader = { read: async () => bytes(64, 2) }

    await expect(readVerified(reader, entryFor(data))).rejects.toThrow('hash to')
  })

  it('compares the hash regardless of its case', async () => {
    const data = bytes(64)
    const reader: DaReader = { read: async () => data }
    const entry = entryFor(data)

    expect(await readVerified(reader, { ...entry, encryptedVoteHash: entry.encryptedVoteHash.toLowerCase() as `0x${string}` })).toEqual(
      data,
    )
  })

  it('rejects an empty answer', async () => {
    await expect(readVerified({ read: async () => new Uint8Array() }, entryFor(bytes(4)))).rejects.toThrow('0 bytes')
  })

  it('passes the whole entry to the reader', async () => {
    const data = bytes(16)
    const read = vi.fn(async () => data)
    const entry = entryFor(data)

    await readVerified({ read }, entry)

    expect(read).toHaveBeenCalledWith(entry)
  })
})

describe('createHttpDaReader', () => {
  it('fetches /objects/<hash> under the base URL', async () => {
    const data = bytes(40)
    const fetch = vi.fn(async () => new Response(data))
    const entry = entryFor(data)

    const read = await createHttpDaReader('https://da.example/availability/', { fetch }).read(entry)

    expect(fetch).toHaveBeenCalledWith(`https://da.example/availability/objects/${entry.encryptedVoteHash}`)
    expect(new Uint8Array(read)).toEqual(data)
  })

  it('throws when the object is unavailable', async () => {
    const fetch = vi.fn(async () => new Response('', { status: 404, statusText: 'Not Found' }))

    await expect(createHttpDaReader('https://da.example', { fetch }).read(entryFor(bytes(4)))).rejects.toThrow('404')
  })
})

describe('createAvailDaReader', () => {
  const rpc = (extrinsics: string[], blockHash: string | null = '0xabc') =>
    vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const { method } = JSON.parse(init?.body as string)
      const result = method === 'chain_getBlockHash' ? blockHash : { block: { extrinsics } }

      return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result }))
    })

  it.each([
    ['a short object', 40],
    ['a two-byte length', 300],
    ['a four-byte length', 20_000],
  ])('finds %s among the extrinsics of the block', async (_name, length) => {
    const data = bytes(length)
    const fetch = rpc([extrinsicOf(bytes(50, 5)), extrinsicOf(data), extrinsicOf(bytes(80, 6))])

    const read = await createAvailDaReader({ rpcUrl: 'https://avail.example/rpc', fetch }).read(entryFor(data))

    expect(read).toEqual(data)
    expect(fetch.mock.calls.map(([, init]) => JSON.parse(init?.body as string))).toMatchObject([
      { method: 'chain_getBlockHash', params: [42] },
      { method: 'chain_getBlock', params: ['0xabc'] },
    ])
  })

  it('throws when the block holds no object with that hash', async () => {
    const fetch = rpc([extrinsicOf(bytes(50, 5))])

    await expect(createAvailDaReader({ rpcUrl: 'https://avail.example/rpc', fetch }).read(entryFor(bytes(60)))).rejects.toThrow(
      'does not contain',
    )
  })

  it('does not return an extrinsic whose payload differs from the hash', async () => {
    const wanted = bytes(60)
    const fetch = rpc([extrinsicOf(bytes(60, 2))])

    await expect(createAvailDaReader({ rpcUrl: 'https://avail.example/rpc', fetch }).read(entryFor(wanted))).rejects.toThrow(
      'does not contain',
    )
  })

  it('throws for an entry with no Avail receipt yet', async () => {
    const fetch = rpc([])
    const entry = entryFor(bytes(10), { availabilityBlock: undefined, availabilityLeafIndex: undefined })

    await expect(createAvailDaReader({ rpcUrl: 'https://avail.example/rpc', fetch }).read(entry)).rejects.toThrow('no Avail receipt')
    expect(fetch).not.toHaveBeenCalled()
  })

  it('throws when Avail has no such block', async () => {
    const fetch = rpc([], null)

    await expect(createAvailDaReader({ rpcUrl: 'https://avail.example/rpc', fetch }).read(entryFor(bytes(10)))).rejects.toThrow(
      'no block 42',
    )
  })

  it('refuses a WebSocket endpoint', () => {
    expect(() => createAvailDaReader({ rpcUrl: 'wss://avail.example/ws' })).toThrow('HTTP or HTTPS')
  })
})

describe('createFallbackDaReader', () => {
  const data = bytes(32)

  it('skips a reader that fails and one that answers with the wrong bytes', async () => {
    const failing: DaReader = { read: async () => Promise.reject(new Error('down')) }
    const lying: DaReader = { read: async () => bytes(32, 2) }
    const honest: DaReader = { read: async () => data }

    expect(await createFallbackDaReader(failing, lying, honest).read(entryFor(data))).toEqual(data)
  })

  it('stops at the first reader that answers correctly', async () => {
    const second = vi.fn(async () => data)

    await createFallbackDaReader({ read: async () => data }, { read: second }).read(entryFor(data))

    expect(second).not.toHaveBeenCalled()
  })

  it('reports what every reader said when none supplies the bytes', async () => {
    const failing: DaReader = { read: async () => Promise.reject(new Error('down')) }
    const lying: DaReader = { read: async () => bytes(32, 2) }

    await expect(createFallbackDaReader(failing, lying).read(entryFor(data))).rejects.toThrow(/No reader supplied entry 3: down; .*hash to/)
  })
})
