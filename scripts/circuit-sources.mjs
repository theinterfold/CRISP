// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

// A digest of the circuit sources the CRISP presets are compiled from.
//
// stage-preset-artifacts.mjs records this digest beside the artifacts it archives, and
// check-staged-preset.mjs recomputes it before a channel build. When the two disagree, the archive
// under circuits/dist/<preset>/ predates the circuits and the build must not use it.
//
// The digest reads content rather than modification times. A `git checkout` rewrites the
// modification time of every file it touches, including files whose content did not change, so a
// time-based check reports a stale archive after an ordinary branch switch and teaches whoever
// publishes to ignore it.

import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const CRISP = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The circuits every staged artifact is compiled from, with the library they import.
 *
 * The Nargo.toml files name the Interfold tag that supplies `interfold_lib`, and
 * interfold-release.json pins the archive that supplies the user_data_encryption circuits, so a
 * move to another Interfold release shows up in this digest.
 */
const SOURCE_DIRS = [join(CRISP, 'circuits/bin/crisp'), join(CRISP, 'circuits/bin/crisp_onchain'), join(CRISP, 'circuits/lib')]
const SOURCE_FILES = [join(CRISP, 'interfold-release.json')]

/** A compile reads these. Everything else in those directories is output or editor noise. */
const SOURCE_FILE = /\.(nr|toml)$/

/** Compiler output and installed packages. Both are derived, and both are large. */
const SKIP_DIRS = new Set(['target', 'node_modules'])

/**
 * The generated preset selector, which the digest must ignore.
 *
 * `compile_circuits.sh` rewrites this file on every preset switch, and `build-presets.mjs` builds
 * insecure-64 last so the working tree is left on the default preset. The tree therefore never
 * holds the selector the secure-8192 archive was staged under, and a digest that included it would
 * report a fresh secure archive as stale every time.
 *
 * Leaving it out costs nothing. The digest answers "have the circuit sources changed", and the
 * preset an archive holds is established three other ways: the directory it sits in, `preset` in
 * its manifest, and the ABI degree that stage-preset-artifacts.mjs checks per artifact.
 */
const GENERATED = new Set([join(CRISP, 'circuits/lib/src/preset.nr')])
// Only the folds import this module; these archives contain ballot/ct leaves, not folds. Its own
// read-only check rederives both stacks' commitments from those exact leaves and pinned identities.
GENERATED.add(join(CRISP, 'circuits/lib/src/fold_anchors.nr'))

const walk = (dir, found) => {
  if (!existsSync(dir)) return found

  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(path, found)
    } else if (SOURCE_FILE.test(entry.name) && !GENERATED.has(path)) {
      found.push(path)
    }
  }

  return found
}

/**
 * Hash every circuit source, keyed by its path relative to the repository root.
 *
 * Paths go into the hash as well as content, so a moved or deleted file changes the digest.
 */
export const circuitSourcesDigest = () => {
  const hash = createHash('sha256')
  const files = [...SOURCE_DIRS.flatMap((dir) => walk(dir, [])), ...SOURCE_FILES].sort()

  for (const file of files) {
    hash.update(relative(CRISP, file))
    hash.update('\0')
    hash.update(readFileSync(file))
    hash.update('\0')
  }

  return { digest: hash.digest('hex'), fileCount: files.length }
}
