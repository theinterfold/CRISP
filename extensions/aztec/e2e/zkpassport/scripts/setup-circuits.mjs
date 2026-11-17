// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

// Fetch the ZKPassport circuits repository the mock-proof generator runs inside of: its TypeScript test helpers build
// the synthetic passport and certificate chain, and its pinned dependencies (@zkpassport/utils, @noir-lang/noir_js, ...)
// are the ones the published circuits were built with. Idempotent: does nothing when the checkout is in place.
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/** `bb-v6.0.0` / `noir-v1.0.0` of zkpassport/circuits: circuits release 0.22.0, the one built for bb 6.0.0 (Aztec 6.0.0). */
const TAG = 'noir-v1.0.0'
const COMMIT = '327d19eb7c63e43e2095ebe03fb3d0e6e03dc44f'

const here = dirname(fileURLToPath(import.meta.url))
const dir = resolve(here, '..', '.cache', 'circuits')
const run = (command, args, cwd) => execFileSync(command, args, { cwd, stdio: 'inherit' })
const head = () => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim()

if (!existsSync(resolve(dir, 'package.json'))) {
  run('git', ['clone', '--depth', '1', '--branch', TAG, 'https://github.com/zkpassport/circuits.git', dir])
}
if (head() !== COMMIT) throw new Error(`${dir} is at ${head()}, expected ${COMMIT} (${TAG}); delete it and run again`)
if (!existsSync(resolve(dir, 'node_modules', '.package-lock.json'))) {
  run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], dir)
}
console.log(`zkpassport/circuits ${TAG} ready at ${dir}`)
