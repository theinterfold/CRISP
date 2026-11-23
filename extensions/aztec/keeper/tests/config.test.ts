// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { describe, expect, it } from 'vitest'

import { loadConfig } from '../src/config'

const env = {
  AZTEC_NODE_URL: 'http://localhost:8080',
  L1_RPC_URL: 'http://localhost:8545',
  KEEPER_L1_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
  CRISP_AZTEC_PROGRAM: '0x5fbdb2315678afecb367f032d93f642f64180aa3',
  CRISP_AZTEC_CONTRACT: `0x${'00'.repeat(31)}01`,
}

describe('loadConfig', () => {
  it('reads the required values and defaults the rest', () => {
    const config = loadConfig(env)
    expect(config.program).toBe('0x5FbDB2315678afecb367f032d93F642f64180aa3')
    expect(config.kind).toBe('zkpassport')
    expect(config.startBlock).toBe(0n)
    expect(config.pollIntervalMs).toBe(10_000)
  })

  it.each(Object.keys(env))('names %s when it is missing', (name) => {
    expect(() => loadConfig({ ...env, [name]: undefined })).toThrow(name)
  })

  it('selects the votes kind and refuses another', () => {
    expect(loadConfig({ ...env, CRISP_AZTEC_KIND: 'votes' }).kind).toBe('votes')
    expect(() => loadConfig({ ...env, CRISP_AZTEC_KIND: 'gnosis' })).toThrow(/CRISP_AZTEC_KIND/)
  })

  it('rejects a malformed key and a bad interval', () => {
    expect(() => loadConfig({ ...env, KEEPER_L1_PRIVATE_KEY: '0x1234' })).toThrow(/32-byte/)
    expect(() => loadConfig({ ...env, KEEPER_POLL_INTERVAL_MS: '0' })).toThrow(/positive integer/)
  })
})
