#!/usr/bin/env node
// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

// Download the Interfold release assets that CRISP uses.
//
// interfold-release.json names the release and the SHA-256 digest of each asset. A download that
// does not match its digest is refused, so a moved tag or a replaced asset cannot change what CRISP
// builds against.
//
//   node scripts/interfold-release.mjs asset <name>  Download one asset and print its path.
//   node scripts/interfold-release.mjs circuits      Extract the user_data_encryption circuits.
//
// `circuits` writes circuits/interfold/:
//
//   user_data_encryption.json                   one artifact serves both presets
//   user_data_encryption.vk_recursive_hash
//   <preset>/user_data_encryption_ct{0,1}.json  shaped by the BFV degree, so one per preset
//   <preset>/user_data_encryption_ct{0,1}.vk_recursive_hash
//
// Each `vk_recursive_hash` is the `noir-recursive-no-zk` key hash that the fold circuits bind.

import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  copyFileSync,
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { fileURLToPath } from 'node:url'

const CRISP = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** The pinned release: `{ version, sha256: { <asset name>: <hex digest> } }`. */
export const RELEASE = JSON.parse(readFileSync(join(CRISP, 'interfold-release.json'), 'utf8'))

/** The directory that `circuits` writes. */
export const CIRCUITS_DIR = join(CRISP, 'circuits/interfold')

const PRESETS = ['insecure-64', 'secure-8192']

/**
 * The committee directory to read from. The user_data_encryption circuits do not depend on the
 * committee size, so every committee directory of the archive holds the same artifacts.
 */
const COMMITTEE = 'minimum'

/** The SHA-256 of a file, read as a stream: the circuit archive is several hundred megabytes. */
const sha256 = async (path) => {
  const hash = createHash('sha256')
  await pipeline(createReadStream(path), hash)
  return hash.digest('hex')
}

/** Download `name` from the pinned release once, verify its digest, and return its path. */
export const fetchAsset = async (name) => {
  const expected = RELEASE.sha256[name]
  if (!expected) throw new Error(`interfold-release.json has no SHA-256 digest for ${name}`)

  const path = join(CRISP, '.interfold/caches/release', RELEASE.version, name)
  if (existsSync(path) && (await sha256(path)) === expected) return path

  const url = `https://github.com/theinterfold/interfold/releases/download/v${RELEASE.version}/${name}`
  const response = await fetch(url)
  if (!response.ok) throw new Error(`GET ${url}: ${response.status} ${response.statusText}`)

  mkdirSync(dirname(path), { recursive: true })
  const partial = `${path}.partial`
  const hash = createHash('sha256')
  const digest = new Transform({
    transform(chunk, _encoding, done) {
      hash.update(chunk)
      done(null, chunk)
    },
  })
  await pipeline(Readable.fromWeb(response.body), digest, createWriteStream(partial))
  const actual = hash.digest('hex')
  if (actual !== expected) {
    rmSync(partial)
    throw new Error(`${name}: SHA-256 is ${actual}, interfold-release.json pins ${expected}`)
  }
  renameSync(partial, path)

  return path
}

/** Extract the user_data_encryption circuits of the pinned release into CIRCUITS_DIR. */
export const extractCircuits = async () => {
  const name = `circuits-${RELEASE.version}.tar.gz`
  const stamp = join(CIRCUITS_DIR, 'release.json')
  const wanted = JSON.stringify({ version: RELEASE.version, sha256: RELEASE.sha256[name] })
  if (existsSync(stamp) && readFileSync(stamp, 'utf8') === wanted) return CIRCUITS_DIR

  const archive = await fetchAsset(name)
  // The archive holds circuits/<preset>/<committee>/<variant>/<group>/<circuit>/<circuit>.<ext>.
  // The `default` variant carries the compiled circuit and its noir-recursive-no-zk key hash.
  const member = (preset, circuit, extension) => `circuits/${preset}/${COMMITTEE}/default/threshold/${circuit}/${circuit}.${extension}`
  const members = [
    [member(PRESETS[0], 'user_data_encryption', 'json'), 'user_data_encryption.json'],
    [member(PRESETS[0], 'user_data_encryption', 'vk_hash'), 'user_data_encryption.vk_recursive_hash'],
    ...PRESETS.flatMap((preset) =>
      ['user_data_encryption_ct0', 'user_data_encryption_ct1'].flatMap((circuit) => [
        [member(preset, circuit, 'json'), `${preset}/${circuit}.json`],
        [member(preset, circuit, 'vk_hash'), `${preset}/${circuit}.vk_recursive_hash`],
      ]),
    ),
  ]

  const scratch = mkdtempSync(join(tmpdir(), 'crisp-interfold-circuits-'))
  try {
    execFileSync('tar', ['-xzf', archive, '-C', scratch, ...members.map(([from]) => from)])

    rmSync(CIRCUITS_DIR, { recursive: true, force: true })
    for (const [from, to] of members) {
      mkdirSync(dirname(join(CIRCUITS_DIR, to)), { recursive: true })
      copyFileSync(join(scratch, from), join(CIRCUITS_DIR, to))
    }
    writeFileSync(stamp, wanted)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }

  return CIRCUITS_DIR
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [command, name] = process.argv.slice(2)
  if (command === 'asset' && name) {
    console.log(await fetchAsset(name))
  } else if (command === 'circuits') {
    console.log(await extractCircuits())
  } else {
    console.error('Usage: interfold-release.mjs asset <name> | circuits')
    process.exit(1)
  }
}
