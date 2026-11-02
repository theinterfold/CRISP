// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { describe, expect, it, vi } from 'vitest'

import { chainHeadPerSlot, slotHeadIndex } from '../src/headRule'
import type { HeadEntry } from '../src/headRule'

// The cases mirror `program/tests/selection.rs`, which pins the Secure Process's rule. Entry `i`
// of a table has tree index `i`, and `parent` names a tree index the way the Rust helper does.
type Entry = { slot: number; usable: boolean; parent: number | null }

const good = (slot: number, parent: number | null = null): Entry => ({ slot, usable: true, parent })
const poisoned = (slot: number, parent: number | null = null): Entry => ({ slot, usable: false, parent })

const slotAddress = (tag: number) => `0x${tag.toString(16).padStart(40, '0')}`

const rows = (entries: Entry[]) =>
  entries.map((entry, index) => ({
    index,
    slot: slotAddress(entry.slot),
    parentIndexPlusOne: entry.parent === null ? 0 : entry.parent + 1,
    usable: entry.usable,
  }))

const select = (entries: Entry[]) => chainHeadPerSlot(rows(entries), (entry) => entry.usable)

describe('chainHeadPerSlot', () => {
  it('follows the chain to its end', async () => {
    expect(await select([good(1)])).toEqual([0])
    expect(await select([good(1), good(1, 0)])).toEqual([1])
    expect(await select([good(1), good(1, 0), good(1, 1)])).toEqual([2])
  })

  it('is not frozen by a poisoned entry', async () => {
    expect(await select([poisoned(1)])).toEqual([])
    expect(await select([good(1), poisoned(1, 0)])).toEqual([0])
    expect(await select([good(1), poisoned(1, 0), good(1, 0)])).toEqual([2])
    expect(await select([good(1), poisoned(1, 0), poisoned(1, 0), good(1, 0)])).toEqual([3])
    expect(await select([poisoned(1), good(1)])).toEqual([1])
  })

  it('lets the first usable sibling keep the slot', async () => {
    // vote A at 0, re-vote B at 1, then a mask naming 0 instead of 1.
    expect(await select([good(1), good(1, 0), good(1, 0)])).toEqual([1])
    // naming no parent on an occupied slot does not restart the chain either
    expect(await select([good(1), good(1, 0), good(1)])).toEqual([1])
  })

  it('names the unchanged head after a poisoned entry', async () => {
    expect(await select([good(1), good(1, 0), poisoned(1, 0), good(1, 1)])).toEqual([3])
  })

  it('drops an entry naming another slot’s parent', async () => {
    expect(await select([good(1), good(2, 0)])).toEqual([0])
  })

  it('resolves interleaved slots independently', async () => {
    expect(await select([good(1), poisoned(2), poisoned(1, 0), good(2)])).toEqual([0, 3])
  })

  it('does not depend on the order entries are listed in', async () => {
    expect(await chainHeadPerSlot(rows([good(1), good(1, 0), good(1, 1)]).reverse(), (entry) => entry.usable)).toEqual([2])
  })

  it('compares slots case-insensitively', async () => {
    const [first, second] = rows([good(0xab), good(0xab, 0)])

    expect(await chainHeadPerSlot([first, { ...second, slot: second.slot.toUpperCase().replace('0X', '0x') }], () => true)).toEqual([1])
  })

  it('refuses two entries at one tree index', async () => {
    const [first] = rows([good(1)])

    await expect(chainHeadPerSlot([first, { ...first }], () => true)).rejects.toThrow('tree index 0')
  })

  it('checks usability only for entries that could become the head', async () => {
    const isUsable = vi.fn((_entry: HeadEntry) => true)

    // 0 is the head; 1 names a parent that is not the head, so its bytes are never needed.
    await chainHeadPerSlot(rows([good(1), good(1, 0), good(1, 0), good(1, 1)]), isUsable)

    expect(isUsable.mock.calls.map(([entry]) => entry.index)).toEqual([0, 1, 3])
  })

  it('awaits an asynchronous usability check', async () => {
    const rowsOf = rows([good(1), good(1, 0)])

    expect(await chainHeadPerSlot(rowsOf, async (entry) => entry.index === 0)).toEqual([0])
  })
})

describe('slotHeadIndex', () => {
  it('resolves one slot and ignores the others', async () => {
    const entries = rows([good(1), good(2), good(1, 0), good(2, 1)])

    expect(await slotHeadIndex(entries, slotAddress(1), (entry) => entry.usable)).toBe(2)
    expect(await slotHeadIndex(entries, slotAddress(2), (entry) => entry.usable)).toBe(3)
  })

  it('is undefined when the slot holds nothing usable', async () => {
    const entries = rows([good(1), poisoned(2)])

    expect(await slotHeadIndex(entries, slotAddress(2), (entry) => entry.usable)).toBeUndefined()
    expect(await slotHeadIndex(entries, slotAddress(3), (entry) => entry.usable)).toBeUndefined()
  })
})
