// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = resolve(__dirname, '../src')

/** Packages whose import drags in wasm, noir or barretenberg. */
const HEAVY = ['@crisp-e3/zk-inputs', '@noir-lang/noir_js', '@aztec/bb.js']

const IMPORT = /^\s*(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]/gm

/** Every module reachable from `entry` through value or type imports, as specifiers by file. */
const importGraph = (entry: string): Map<string, string[]> => {
  const graph = new Map<string, string[]>()
  const visit = (file: string) => {
    if (graph.has(file)) return
    const specifiers = [...readFileSync(file, 'utf8').matchAll(IMPORT)].map((match) => match[1])
    graph.set(file, specifiers)
    for (const specifier of specifiers.filter((s) => s.startsWith('.'))) visit(`${resolve(dirname(file), specifier)}.ts`)
  }
  visit(entry)

  return graph
}

describe('@crisp-e3/sdk/chain entry', () => {
  const graph = importGraph(resolve(SRC, 'light.ts'))

  it('reaches no wasm, noir or bb.js import', () => {
    const heavy = [...graph].flatMap(([file, specifiers]) =>
      specifiers.filter((s) => HEAVY.some((h) => s.startsWith(h))).map((s) => `${file}: ${s}`),
    )

    expect(heavy).toEqual([])
  })

  it('stays inside the chain-only modules', () => {
    const files = [...graph.keys()].map((file) => file.slice(SRC.length + 1)).sort()

    expect(files).toEqual(['chain.ts', 'light.ts', 'logs.ts', 'round.ts'])
  })
})
