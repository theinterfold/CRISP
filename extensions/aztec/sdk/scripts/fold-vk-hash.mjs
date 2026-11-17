// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

// Prints the hash of the fold circuit's `noir-recursive` verification key, the `fold_vk_hash` that `crisp_aztec`
// is deployed with. Same value as `bb write_vk -t noir-recursive -b circuits/bin/fold/target/crisp_fold.json`
// (bb 6.0.0); the fold circuit holds no preset-bound data, so one hash serves every preset.
//
// Needs the compiled fold circuit (`cd circuits/bin/fold && nargo compile`) and a built `@crisp-e3/sdk`.
import { destroyBBApi, getFoldRecursiveVerificationKey } from '@crisp-e3/sdk'

const { vkFields, vkHash } = await getFoldRecursiveVerificationKey()
console.log(vkHash)
console.error(`fold verification key: ${vkFields.length} fields`)
destroyBBApi()
