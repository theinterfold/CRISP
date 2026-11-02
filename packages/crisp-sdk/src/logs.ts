// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import type { AbiEvent, Address, GetLogsReturnType, PublicClient } from 'viem'

/** Blocks per `eth_getLogs` call. Hosted providers commonly cap the range at 10k or fewer. */
export const DEFAULT_LOG_CHUNK_SIZE = 5_000n

/**
 * What to scan: one event of one contract over a block range.
 */
export type ScanLogsParams<TEvent extends AbiEvent> = {
  /** The emitting contract. */
  address: Address
  /** The event to decode, as an ABI item (e.g. from `parseAbiItem`). */
  event: TEvent
  /** Indexed-argument filter, as viem's `getLogs` takes it. */
  args?: Record<string, unknown>
  /** First block to scan, inclusive. */
  fromBlock: bigint
  /** Last block to scan, inclusive. Defaults to the chain head at the time of the call. */
  toBlock?: bigint
  /** Blocks per request. Lower it for a provider with a tighter range cap. Defaults to 5000. */
  chunkSize?: bigint
}

/**
 * Read an event's logs over a block range in fixed-size `eth_getLogs` requests.
 *
 * A single request over `fromBlock..latest` is exactly what hosted providers reject, on range or
 * result-count limits, so the range is walked oldest to newest in chunks and the results are
 * concatenated in chain order.
 *
 * @param client - The public client to read through
 * @param params - The contract, event, filter and block range
 * @returns The decoded logs, ordered by block and log index
 */
export const scanLogs = async <TEvent extends AbiEvent>(
  client: PublicClient,
  { address, event, args, fromBlock, toBlock, chunkSize = DEFAULT_LOG_CHUNK_SIZE }: ScanLogsParams<TEvent>,
): Promise<GetLogsReturnType<TEvent, [TEvent], true>> => {
  if (chunkSize <= 0n) throw new Error('chunkSize must be positive')

  const last = toBlock ?? (await client.getBlockNumber())
  const logs: unknown[] = []

  for (let start = fromBlock; start <= last; start += chunkSize) {
    const end = start + chunkSize - 1n < last ? start + chunkSize - 1n : last
    // `args` is a runtime filter over whatever event the caller passed; viem's generic typing
    // cannot follow a caller-supplied ABI item, so the call is untyped and the result re-typed.
    const chunk = await client.getLogs({ address, event, args, fromBlock: start, toBlock: end, strict: true } as never)
    logs.push(...(chunk as unknown[]))
  }

  return logs as GetLogsReturnType<TEvent, [TEvent], true>
}

/**
 * The first block whose timestamp is at or after `timestamp`.
 *
 * Interfold stores `E3.requestBlock` as `block.timestamp`, not a block number, so any scan that
 * wants "from the round's request" has to convert it first. Handing the timestamp to `fromBlock`
 * asks for block ~1.8 billion on a chain whose head is in the millions: no error, just no logs.
 *
 * "First block at or after" is the safe lower bound for a scan: it never skips the block the
 * timestamp belongs to, even on a chain where several blocks share a timestamp. A timestamp past
 * the chain head resolves to the head, and one before genesis resolves to block 0.
 *
 * @param client - The public client to read through
 * @param timestamp - The unix timestamp, in seconds
 * @returns The block number
 */
export const blockAtTimestamp = async (client: PublicClient, timestamp: bigint): Promise<bigint> => {
  const latest = await client.getBlock({ blockTag: 'latest' })
  if (timestamp >= latest.timestamp) return latest.number

  // Binary search over [lo, hi] for the smallest block with `block.timestamp >= timestamp`.
  // Invariant: `hi` satisfies the predicate. Timestamps are non-decreasing in block number.
  let lo = 0n
  let hi = latest.number
  while (lo < hi) {
    const mid = (lo + hi) / 2n
    const block = await client.getBlock({ blockNumber: mid })
    if (block.timestamp >= timestamp) hi = mid
    else lo = mid + 1n
  }

  return hi
}
