// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

// Fetch the ZKPassport circuits repository the mock-proof generator runs inside of: its TypeScript test helpers build
// the synthetic passport and certificate chain, and its pinned dependencies (@zkpassport/utils, @noir-lang/noir_js, ...)
// are the ones the published circuits were built with. Idempotent: does nothing when the checkout is in place.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * The "Release 0.23.0" commit of zkpassport/circuits: circuits release 0.23.0, built for bb 6.0.0 (Aztec 6.0.0). The release has no
 * git tag (`bb-v6.0.0` and `noir-v1.0.0` are 0.22.0), so it is fetched by commit.
 */
const COMMIT = '4d90f1f8793b021925772ee2e0dba0588447b687'

const here = dirname(fileURLToPath(import.meta.url))
const dir = resolve(here, '..', '.cache', 'circuits')
const run = (command, args, cwd) => execFileSync(command, args, { cwd, stdio: 'inherit' })
const head = () => execFileSync('git', ['rev-parse', 'HEAD'], { cwd: dir }).toString().trim()

if (!existsSync(resolve(dir, 'package.json'))) {
  mkdirSync(dir, { recursive: true })
  run('git', ['init', '--quiet'], dir)
  run('git', ['fetch', '--quiet', '--depth', '1', 'https://github.com/zkpassport/circuits.git', COMMIT], dir)
  run('git', ['checkout', '--quiet', 'FETCH_HEAD'], dir)
}
if (head() !== COMMIT) throw new Error(`${dir} is at ${head()}, expected ${COMMIT} (circuits 0.23.0); delete it and run again`)
if (!existsSync(resolve(dir, 'node_modules', '.package-lock.json'))) {
  run('npm', ['ci', '--ignore-scripts', '--no-audit', '--no-fund'], dir)
}
console.log(`zkpassport/circuits 0.23.0 ready at ${dir}`)
