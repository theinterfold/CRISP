// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

// Refuse to publish a build that a client cannot use. The build inlines the compiled Aztec contracts
// (`../contracts/target`, which git does not track), and a client can only use a deployed contract whose class is
// the class of the inlined artifact.

import { readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const sdk = fileURLToPath(new URL('..', import.meta.url))
const contracts = join(sdk, '../contracts')
const modified = (path) => statSync(path).mtimeMs

/** When the newest contract source under `dir` changed. */
const newestSource = (dir) =>
  readdirSync(dir, { withFileTypes: true }).reduce((newest, entry) => {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === 'target' ? newest : Math.max(newest, newestSource(path))
    return entry.name.endsWith('.nr') || entry.name === 'Nargo.toml' ? Math.max(newest, modified(path)) : newest
  }, 0)

// 1. The artifacts are compiled from the sources as they are now, and the build is made from those artifacts.
const sources = newestSource(contracts)
const entries = ['index', 'passport']
for (const artifact of ['crisp_aztec-CrispAztec', 'crisp_aztec_votes-CrispAztecVotes']) {
  const compiled = modified(join(contracts, 'target', `${artifact}.json`))
  if (compiled < sources) {
    throw new Error(`${artifact}.json is older than the contract sources. Run \`aztec compile\` in extensions/aztec/contracts.`)
  }
  for (const entry of entries) {
    if (modified(join(sdk, 'dist', `${entry}.js`)) < compiled) {
      throw new Error(`dist/${entry}.js is older than ${artifact}.json. Run \`pnpm build\`.`)
    }
  }
}

// 2. The build loads. Each entry reads the artifact it inlines when it is imported, which throws for an artifact
// that `aztec compile` did not transpile (a compile from a member directory, or with `aztec-nargo compile`).
for (const entry of entries) {
  await import(new URL(`../dist/${entry}.js`, import.meta.url).href)
}
console.log('@crisp-e3/aztec: the build is current and both entries load')
