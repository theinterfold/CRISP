// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { describe, expect, it, vi } from 'vitest'
import { parseAbiItem } from 'viem'

import { blockAtTimestamp, scanLogs } from '../src/logs'

import type { PublicClient } from 'viem'

const event = parseAbiItem('event Ping(uint256 indexed id)')
const address = '0x00000000000000000000000000000000000000aa'

describe('scanLogs', () => {
  const clientWith = (head: bigint) => {
    const getLogs = vi.fn(async ({ fromBlock, toBlock }: { fromBlock: bigint; toBlock: bigint }) => [{ blockNumber: fromBlock, toBlock }])
    const client = { getBlockNumber: vi.fn(async () => head), getLogs } as unknown as PublicClient

    return { client, getLogs }
  }

  it('walks the range in chunk-sized, inclusive, non-overlapping requests', async () => {
    const { client, getLogs } = clientWith(0n)

    await scanLogs(client, { address, event, fromBlock: 100n, toBlock: 12_099n, chunkSize: 5_000n })

    expect(getLogs.mock.calls.map(([q]) => [q.fromBlock, q.toBlock])).toEqual([
      [100n, 5_099n],
      [5_100n, 10_099n],
      [10_100n, 12_099n],
    ])
  })

  it('concatenates chunk results oldest first', async () => {
    const { client } = clientWith(0n)

    const logs = await scanLogs(client, { address, event, fromBlock: 0n, toBlock: 9n, chunkSize: 4n })

    expect(logs.map((log) => log.blockNumber)).toEqual([0n, 4n, 8n])
  })

  it('defaults the upper bound to the chain head and the chunk size to 5000', async () => {
    const { client, getLogs } = clientWith(5_000n)

    await scanLogs(client, { address, event, fromBlock: 0n })

    expect(getLogs.mock.calls.map(([q]) => [q.fromBlock, q.toBlock])).toEqual([
      [0n, 4_999n],
      [5_000n, 5_000n],
    ])
  })

  it('forwards the address, event and args to every request', async () => {
    const { client, getLogs } = clientWith(0n)

    await scanLogs(client, { address, event, args: { id: 7n }, fromBlock: 0n, toBlock: 1n })

    expect(getLogs).toHaveBeenCalledWith(expect.objectContaining({ address, event, args: { id: 7n } }))
  })

  it('makes no request for an empty range and rejects a non-positive chunk size', async () => {
    const { client, getLogs } = clientWith(0n)

    expect(await scanLogs(client, { address, event, fromBlock: 10n, toBlock: 9n })).toEqual([])
    expect(getLogs).not.toHaveBeenCalled()
    await expect(scanLogs(client, { address, event, fromBlock: 0n, toBlock: 1n, chunkSize: 0n })).rejects.toThrow('chunkSize')
  })
})

describe('blockAtTimestamp', () => {
  /** Block `n` carries `timestamps[n]`; `getBlock` mimics viem's two call shapes. */
  const chainOf = (timestamps: bigint[]) => {
    const getBlock = vi.fn(async (args: { blockTag?: 'latest'; blockNumber?: bigint }) => {
      const number = args.blockTag === 'latest' ? BigInt(timestamps.length - 1) : (args.blockNumber as bigint)
      return { number, timestamp: timestamps[Number(number)] }
    })

    return { client: { getBlock } as unknown as PublicClient, getBlock }
  }

  const everyTwelve = Array.from({ length: 1_000 }, (_, n) => 1_000n + 12n * BigInt(n))

  it('finds the block with exactly that timestamp', async () => {
    const { client } = chainOf(everyTwelve)

    expect(await blockAtTimestamp(client, 1_000n + 12n * 421n)).toBe(421n)
  })

  it('rounds up to the first block at or after a timestamp between blocks', async () => {
    const { client } = chainOf(everyTwelve)

    expect(await blockAtTimestamp(client, 1_000n + 12n * 421n - 1n)).toBe(421n)
    expect(await blockAtTimestamp(client, 1_000n + 12n * 421n + 1n)).toBe(422n)
  })

  it('returns the first of several blocks that share a timestamp', async () => {
    const { client } = chainOf([10n, 20n, 20n, 20n, 30n])

    expect(await blockAtTimestamp(client, 20n)).toBe(1n)
  })

  it('clamps to genesis before the chain and to the head after it', async () => {
    const { client } = chainOf(everyTwelve)

    expect(await blockAtTimestamp(client, 0n)).toBe(0n)
    expect(await blockAtTimestamp(client, 1_000_000n)).toBe(999n)
  })

  it('needs only a logarithmic number of block reads', async () => {
    const { client, getBlock } = chainOf(everyTwelve)

    await blockAtTimestamp(client, 1_000n + 12n * 421n)

    expect(getBlock.mock.calls.length).toBeLessThanOrEqual(12)
  })
})
