#!/usr/bin/env node
// SPDX-License-Identifier: LGPL-3.0-only

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BFV_PRESETS } from '@interfold/contracts/bfv'
import { readBfvCircuitIdentity } from '@interfold/contracts/scripts/utils'
import { CIRCUITS_DIR, RELEASE, extractCircuits } from './interfold-release.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const check = args.includes('--check')
const selected = args.find((arg) => !arg.startsWith('--'))
if (
  args.some((arg) => arg.startsWith('--') && !['--check', '--live'].includes(arg)) ||
  (selected && !Object.hasOwn(BFV_PRESETS, selected))
) {
  throw new Error('Usage: fold-anchors.mjs [insecure-64|secure-8192] [--check] [--live]')
}
if (args.includes('--live') && !selected) throw new Error('--live requires a selected preset')
const presets = selected ? [selected] : Object.keys(BFV_PRESETS)
const interfold = check ? CIRCUITS_DIR : await extractCircuits()
const stamp = JSON.parse(readFileSync(join(interfold, 'release.json'), 'utf8'))
if (stamp.version !== RELEASE.version || stamp.sha256 !== RELEASE.sha256[`circuits-${RELEASE.version}.tar.gz`])
  throw new Error('Extracted Interfold release is stale; prepare the pinned archive')
const release = join(interfold, 'release')
process.env.INTERFOLD_CIRCUITS_DIR = release
const output = join(root, 'circuits/lib/src/fold_anchors.nr')
const current = readFileSync(output, 'utf8')
let generated = current
const job = mkdtempSync(join(tmpdir(), 'crisp-fold-anchors-'))
try {
  for (const preset of presets) {
    if (!args.includes('--live'))
      execFileSync(process.execPath, [join(root, 'scripts/check-staged-preset.mjs'), preset], { cwd: root, stdio: 'pipe' })
    const config = { preset, committee: 'minimum' }
    const identities = ['user_data_encryption', 'user_data_encryption_ct0', 'user_data_encryption_ct1'].map((circuit) =>
      readBfvCircuitIdentity(`threshold/${circuit}`, 'default', 'bb-vk-hash', config),
    )
    const paths = identities.map((value, index) => {
      const path = join(job, `${index}.hash`)
      writeFileSync(path, Buffer.from(value.slice(2), 'hex'))
      return path
    })
    for (const ballot of ['crisp', 'crisp_onchain']) {
      const artifact = args.includes('--live')
        ? join(root, `circuits/bin/${ballot}/target/${ballot}.json`)
        : join(root, `circuits/dist/${preset}/${ballot}.json`)
      const compiled = JSON.parse(readFileSync(artifact, 'utf8'))
      const degree = Number(BFV_PRESETS[preset].threshold.degree)
      const widths = JSON.stringify(compiled.abi.parameters).match(/"length":(\d+)/g) ?? []
      const actual = Math.max(0, ...widths.map((width) => Number(width.split(':')[1])))
      if (actual !== degree && actual !== 2 * degree - 1) throw new Error(`Wrong ballot preset: ${artifact}`)
      // Re-derive the ballot key from the compiled application, never a neighboring cached hash.
      execFileSync('bb', ['write_vk', '-b', artifact, '-o', job, '-t', 'noir-recursive-no-zk'], { stdio: 'pipe' })
      const value = execFileSync(
        'cargo',
        [
          'run',
          '--quiet',
          '--locked',
          '--release',
          '-p',
          'zk-inputs',
          '--bin',
          'fold_key_hash',
          '--',
          paths[0],
          join(job, 'vk_hash'),
          paths[1],
          paths[2],
        ],
        { cwd: root, encoding: 'utf8' },
      ).trim()
      if (!/^0x[0-9a-f]{64}$/.test(value)) throw new Error('Invalid ordered fold commitment')
      const name = `${ballot.toUpperCase()}_FOLD_EXPECTED_KEY_HASH_${preset === 'insecure-64' ? 'INSECURE' : 'SECURE'}`
      const declaration = new RegExp(`pub global ${name}: Field =\\s*0x[0-9a-f]+;`, 'g')
      if ([...generated.matchAll(declaration)].length !== 1) throw new Error(`Missing or duplicate ${name}`)
      generated = generated.replace(declaration, `pub global ${name}: Field =\n    ${value};`)
      console.log(`${preset}/${ballot}: ${value}`)
    }
  }
  if (check && generated !== current) throw new Error('Shared fold anchors are stale; run pnpm compute:vk-hash for each changed preset')
  if (!check && generated !== current) writeFileSync(output, generated)
  if (selected) console.log('Selected-preset anchors only; not complete application-matrix acceptance.')
} finally {
  rmSync(job, { recursive: true, force: true })
}
