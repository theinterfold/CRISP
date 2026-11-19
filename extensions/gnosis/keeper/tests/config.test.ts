// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { describe, expect, it } from 'vitest'

import { loadConfig } from '../src/config'

const env = {
  KEEPER_SEPOLIA_RPC_URL: 'http://localhost:8545',
  KEEPER_SEPOLIA_PRIVATE_KEY: `0x${'11'.repeat(32)}`,
  KEEPER_CHIADO_RPC_URL: 'http://localhost:8546',
  KEEPER_CHIADO_PRIVATE_KEY: `0x${'22'.repeat(32)}`,
  CRISP_GNOSIS_PROGRAM: '0x5fbdb2315678afecb367f032d93f642f64180aa3',
  CRISP_GNOSIS_VOTING: '0xe7f1725e7734ce288f8367e1bb143e90bb3f0512',
  KEEPER_AMB_HELPER: '0x3cc500B3c01D04C265c9293cB35BA2Fd8eA6dc1b',
}

describe('loadConfig', () => {
  it('reads the required values and defaults the rest', () => {
    const config = loadConfig(env)
    expect(config.program).toBe('0x5FbDB2315678afecb367f032d93F642f64180aa3')
    expect(config.module).toBeUndefined()
    expect(config.startBlockSepolia).toBe(0n)
    expect(config.pollIntervalMs).toBe(10_000)
  })

  it.each(Object.keys(env))('names %s when it is missing', (name) => {
    expect(() => loadConfig({ ...env, [name]: undefined })).toThrow(name)
  })

  it('rejects a malformed key and a bad interval', () => {
    expect(() => loadConfig({ ...env, KEEPER_SEPOLIA_PRIVATE_KEY: '0x1234' })).toThrow(/32-byte/)
    expect(() => loadConfig({ ...env, KEEPER_POLL_INTERVAL_MS: '0' })).toThrow(/positive integer/)
  })

  it('needs a metadata URL with {cid} to run the module', () => {
    const module = '0xcf7ed3acca5a467e9e704c703e8d87f634fb0fc9'
    expect(() => loadConfig({ ...env, CRISP_GOVERNANCE_MODULE: module })).toThrow(/KEEPER_METADATA_URL/)
    expect(() => loadConfig({ ...env, CRISP_GOVERNANCE_MODULE: module, KEEPER_METADATA_URL: 'http://x/ipfs' })).toThrow(/\{cid\}/)
    const config = loadConfig({ ...env, CRISP_GOVERNANCE_MODULE: module, KEEPER_METADATA_URL: 'http://x/{cid}' })
    expect(config.module).toBe('0xCf7Ed3AccA5a467e9e704C703E8D87F634fB0Fc9')
  })
})
