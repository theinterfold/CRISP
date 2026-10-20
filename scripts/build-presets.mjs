#!/usr/bin/env node
// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

// Compile and stage the CRISP circuits for the requested preset set.
//
// The preset is a global compile-time choice (circuits/lib/src/preset.nr), so the presets cannot be
// built concurrently — each pass switches the tree, compiles, and archives the result under
// circuits/dist/<preset>/ before the next pass overwrites it.
//
// The user_data_encryption circuits come compiled from the pinned Interfold release; staging takes
// the preset's copies from circuits/interfold/.

import { execFileSync } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const CRISP = resolve(dirname(fileURLToPath(import.meta.url)), '..')
// insecure-64 is last, so the tree is left on the preset that the repository holds.
const ALL_PRESETS = ['secure-8192', 'insecure-64']

const usage = () => {
  console.error('Usage: build-presets.mjs [--preset insecure-64|secure-8192] [--all]')
  console.error('Defaults to --preset insecure-64 for pull-request CI and local development.')
}

const args = process.argv.slice(2)
let requested = 'insecure-64'
for (let i = 0; i < args.length; i++) {
  const arg = args[i]
  if (arg === '--all') {
    requested = 'all'
  } else if (arg === '--preset') {
    requested = args[++i]
  } else {
    usage()
    process.exit(1)
  }
}

const PRESETS = requested === 'all' ? ALL_PRESETS : [requested]
for (const preset of PRESETS) {
  if (!ALL_PRESETS.includes(preset)) {
    usage()
    process.exit(1)
  }
}

const run = (cmd, args, cwd) => {
  console.log(`   $ ${cmd} ${args.join(' ')}`)
  execFileSync(cmd, args, { cwd, stdio: 'inherit' })
}

for (const preset of PRESETS) {
  console.log(`\n🔮 Building CRISP circuits for ${preset}...`)

  // Selects the preset, compiles the CRISP circuits, and writes the generated Solidity verifiers
  // into packages/crisp-contracts/contracts/verifiers/.
  run('bash', ['scripts/compile_circuits.sh', preset], CRISP)

  run('node', [join(CRISP, 'scripts/stage-preset-artifacts.mjs'), preset], CRISP)
}

console.log(`\n✓ staged ${PRESETS.length} preset(s); tree left on ${PRESETS.at(-1)}`)
console.log('  If ballot circuits changed, update the fold key hashes printed by pnpm compute:vk-hash <preset>.')
if (requested === 'all') {
  console.log('  Then rebuild the production SDK: pnpm -C packages/crisp-sdk build:prod')
  console.log('  Then check it: CRISP_CHANNEL=latest pnpm -C packages/crisp-sdk check:presets')
} else {
  console.log('  Then rebuild the testing SDK: pnpm -C packages/crisp-sdk build')
}
