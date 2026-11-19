// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

/** Public RPCs refuse `eth_getLogs` over wide block ranges: every scan asks for at most this many blocks at once. */
export const LOG_CHUNK = 10_000n

/** The block ranges `[from, to]` of at most `size` blocks that cover `from..to`, oldest first. */
export const blockRanges = (from: bigint, to: bigint, size = LOG_CHUNK): [bigint, bigint][] => {
  const ranges: [bigint, bigint][] = []
  for (let start = from; start <= to; start += size) ranges.push([start, start + size - 1n < to ? start + size - 1n : to])

  return ranges
}

/** The first log `search` finds in `from..to`, looking at the newest blocks first: what a keeper wants is recent. */
export const findLog = async <T>(search: (from: bigint, to: bigint) => Promise<T[]>, from: bigint, to: bigint): Promise<T | undefined> => {
  for (const [start, end] of blockRanges(from, to).reverse()) {
    const [hit] = await search(start, end)
    if (hit) return hit
  }

  return undefined
}
