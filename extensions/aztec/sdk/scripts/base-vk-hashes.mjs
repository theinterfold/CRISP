// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

// Prints the hashes of the `noir-recursive-no-zk` verification keys of the three base circuits of a BFV preset, the
// `ct0_vk_hash`, `ct1_vk_hash` and `crisp_vk_hash` that `crisp_aztec` is deployed with:
//
//   pnpm base-vk-hashes insecure-64     (or secure-8192)
//
// Unlike the fold's, they depend on the preset. Needs a built `@crisp-e3/sdk` with the preset's circuits staged
// (`pnpm stage:preset <preset>` in `packages/crisp-sdk`).
import { destroyBBApi, getBaseVerificationKeys, setCircuits } from '@crisp-e3/sdk'

const preset = process.argv[2]
if (!preset) {
  console.error('usage: pnpm base-vk-hashes <preset>   (insecure-64 or secure-8192)')
  process.exit(1)
}

const { loadCircuits } = await import(`@crisp-e3/sdk/${preset}`)
setCircuits(await loadCircuits())
const keys = await getBaseVerificationKeys()
console.log(JSON.stringify({ ct0: keys.ct0.vkHash, ct1: keys.ct1.vkHash, crisp: keys.crisp.vkHash }, null, 2))
destroyBBApi()
