// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

/**
 * The rule that decides which entry holds a slot: a port of `chain_head_per_slot` from the CRISP
 * Secure Process (`program/src/lib.rs`), which is also what the CRISP server runs
 * (`InputSnapshot::slot_head`).
 *
 * The input tree is append-only, so a slot accumulates entries. Each entry names the tree index it
 * extends (`parentIndexPlusOne`, zero for none). Walking the entries in tree-index order, an entry
 * becomes the slot's head only when both hold:
 *
 * - its published bytes reproduce its commitment (it is *usable*), and
 * - the entry it names is the slot's current head — or it names nothing and the slot has no head.
 *
 * An unusable entry is therefore never a parent, a stale sibling is dropped, and a slot whose
 * entries are all unusable has no head. A new input must name the head this rule returns, or the
 * tally drops it.
 *
 * This module holds only the rule. It never reads a chain or a ciphertext: the caller decides what
 * "usable" means, which is what keeps this file free of wasm.
 */

/** What the rule needs of one entry: its tree index, its slot, and the parent it names. */
export type HeadEntry = {
  /** The entry's leaf position in the round's input tree, as emitted by `CRISPProgram`. */
  index: number
  /** The slot the entry was written to. Compared case-insensitively. */
  slot: string
  /** The tree index of the entry it extends, plus one. Zero means it extends nothing. */
  parentIndexPlusOne: number
}

/**
 * Decides whether an entry's bytes reproduce its commitment. Called at most once per entry, and
 * only for entries whose parent is the slot's current head, so a caller can fetch bytes lazily.
 */
export type IsUsable<E extends HeadEntry> = (entry: E) => boolean | Promise<boolean>

/**
 * The tree index at the end of each slot's chain of usable entries.
 *
 * Entries of different slots do not interact: a parent is compared only with the head of the
 * entry's own slot.
 *
 * @param entries - Every entry of the round (or of the slots of interest), in any order. The rule
 *                  walks them in ascending tree-index order, which is the order the tree was built.
 * @param isUsable - Whether an entry's bytes reproduce its commitment.
 * @returns The selected tree indexes, ascending, one per slot that holds a usable entry.
 * @throws If two entries share a tree index, which no chain can produce.
 */
export const chainHeadPerSlot = async <E extends HeadEntry>(entries: readonly E[], isUsable: IsUsable<E>): Promise<number[]> => {
  const ordered = [...entries].sort((a, b) => a.index - b.index)
  const head = new Map<string, number>()

  ordered.forEach((entry, position) => {
    if (position > 0 && ordered[position - 1].index === entry.index) {
      throw new Error(`Two entries claim tree index ${entry.index}`)
    }
  })

  for (const entry of ordered) {
    const slot = entry.slot.toLowerCase()
    const parent = entry.parentIndexPlusOne === 0 ? undefined : entry.parentIndexPlusOne - 1

    // The Secure Process tests usability first and the parent second; both must hold, so testing
    // the parent first selects the same entries while sparing the usability check — which costs
    // bytes and a commitment — for entries that cannot become the head either way.
    if (parent !== head.get(slot)) continue
    if (!(await isUsable(entry))) continue

    head.set(slot, entry.index)
  }

  return [...head.values()].sort((a, b) => a - b)
}

/**
 * The tree index that holds one slot, or `undefined` when the slot holds nothing usable.
 *
 * @param entries - The entries of the round. Entries of other slots are ignored.
 * @param slot - The slot to resolve.
 * @param isUsable - Whether an entry's bytes reproduce its commitment.
 */
export const slotHeadIndex = async <E extends HeadEntry>(
  entries: readonly E[],
  slot: string,
  isUsable: IsUsable<E>,
): Promise<number | undefined> => {
  const wanted = slot.toLowerCase()
  const [index] = await chainHeadPerSlot(
    entries.filter((entry) => entry.slot.toLowerCase() === wanted),
    isUsable,
  )

  return index
}
