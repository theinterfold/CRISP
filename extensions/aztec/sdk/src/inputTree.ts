// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { poseidon2 } from 'poseidon-lite'

import { MAX_LEAVES } from './constants'

/**
 * Root of a round's input tree, byte-identical to `InternalLazyIMT._root()` of the L1 `CRISPProgram` and to what
 * the Aztec contract reports at close.
 *
 * Zero-subtree values are `Z_0 = 0`, `Z_{i+1} = poseidon(Z_i, Z_i)`; the depth is the smallest `d >= 1` with
 * `2^d >= n`, so the root of an empty tree is `Z_1`. This is how the OpenVM guest and the program server hash
 * the same inputs, which is why the Aztec tree cannot use any other shape.
 */
export const inputTreeRoot = (leaves: readonly bigint[]): bigint => {
  if (leaves.length > MAX_LEAVES) throw new Error(`An input tree holds at most ${MAX_LEAVES} leaves`)

  let depth = 1
  while (2 ** depth < leaves.length) depth++

  let level = [...leaves]
  let zero = 0n
  for (let i = 0; i < depth; i++) {
    const next: bigint[] = []
    for (let j = 0; j < level.length; j += 2) next.push(poseidon2([level[j], j + 1 < level.length ? level[j + 1] : zero]))
    // An empty level still contributes the zero subtree of its height.
    level = next.length === 0 ? [poseidon2([zero, zero])] : next
    zero = poseidon2([zero, zero])
  }

  return level[0]
}
