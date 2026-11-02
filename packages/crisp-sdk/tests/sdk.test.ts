// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as Round from '../src/round'
import { CrispSDK, SERVER_RPC } from '../src/sdk'

const reads = vi.hoisted(() => ({
  getRoundState: vi.fn(async () => ({ stage: 'KeyPublished' })),
  getSlotStatus: vi.fn(async () => ({ active: false, entries: 0 })),
  getCommitteePublicKeyCandidates: vi.fn(async () => []),
}))

vi.mock('../src/round', async (importOriginal) => ({ ...(await importOriginal<typeof Round>()), ...reads }))

const keyReads = vi.hoisted(() => ({ getCommitteePublicKey: vi.fn(async () => Uint8Array.of(1, 2, 3)) }))

vi.mock('../src/committeeKey', () => keyReads)

describe('CrispSDK without a server', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  const e3Id = 5n
  const round = { interfoldAddress: '0x00000000000000000000000000000000000000c0', e3Id, chainId: 11155111 }

  it('can be created with no arguments, or with an options object', () => {
    expect(() => new CrispSDK()).not.toThrow()
    expect(() => new CrispSDK({ rpcUrl: 'https://rpc.example' })).not.toThrow()
    expect(() => new CrispSDK(undefined, 'https://rpc.example')).not.toThrow()
  })

  it('refuses SERVER_RPC without a server to route through', () => {
    expect(() => new CrispSDK(undefined, SERVER_RPC)).toThrow(/needs a serverUrl/)
    expect(() => new CrispSDK({ rpcUrl: SERVER_RPC })).toThrow(/needs a serverUrl/)
  })

  it('throws a clear error from methods that call the server', async () => {
    const sdk = new CrispSDK({ rpcUrl: 'https://rpc.example' })

    await expect(sdk.getRoundStateLite(e3Id)).rejects.toThrow(/without a serverUrl/)
    await expect(sdk.getCurrentRound()).rejects.toThrow(/without a serverUrl/)
    expect(() => sdk.chainRpcUrl()).toThrow(/without a serverUrl/)
  })

  it('keeps the positional form working, including SERVER_RPC', () => {
    const sdk = new CrispSDK('https://crisp.example', SERVER_RPC)

    expect(sdk.chainRpcUrl()).toContain('https://crisp.example')
  })

  it('forwards its rpcUrl to the chain reads', async () => {
    const sdk = new CrispSDK({ rpcUrl: 'https://rpc.example' })

    await sdk.getRoundState(round)
    await sdk.getCommitteePublicKey(round)
    await sdk.getCommitteePublicKeyCandidates(round)
    await sdk.getSlotStatus({ programAddress: '0x00000000000000000000000000000000000000e0', e3Id, slot: '0x00000000000000000000000000000000000000f0', chainId: 1 })

    expect(reads.getRoundState).toHaveBeenCalledWith({ ...round, rpcUrl: 'https://rpc.example' })
    expect(keyReads.getCommitteePublicKey).toHaveBeenCalledWith({ ...round, rpcUrl: 'https://rpc.example' })
    expect(reads.getCommitteePublicKeyCandidates).toHaveBeenCalledWith({ ...round, rpcUrl: 'https://rpc.example' })
    expect(reads.getSlotStatus).toHaveBeenCalledWith(expect.objectContaining({ e3Id, rpcUrl: 'https://rpc.example' }))
  })
})
