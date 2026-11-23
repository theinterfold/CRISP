// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { generateMerkleTree } from '@crisp-e3/sdk'
import { getAddress, toHex, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { describe, expect, it } from 'vitest'

import type { TypedDataSigner } from '../src/ballot'
import { stagingTreeFromLogs } from '../src/census'
import type { StagingKeyBound } from '../src/logs'
import { e3IdOf } from '../src/messages'
import {
  buildVotesStagingPass,
  stagingCommitment,
  stagingKeyBinding,
  stagingSecret,
  stagingSecretStore,
  votesStagingTag,
} from '../src/votes-staging'

const INTERFOLD = getAddress('0xdFa59d66c173A00643eBE80e172Af5a8Cf244b30')
const PROGRAM = getAddress('0x25Df8D3C04D67efb6198E215963d19a8d119ADFF')
const E3_ID = e3IdOf(INTERFOLD, 7n)
const KEY: Hex = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const account = privateKeyToAccount(KEY)
const signer: TypedDataSigner = (typedData) => account.signTypedData(typedData as never)

describe('staging secret', () => {
  // `staging_secret` / `staging_commitment` of `crisp_aztec_votes` for r = 0x11..11, s = 0x22..22, round 7.
  const signature: Hex = `0x${'11'.repeat(32)}${'22'.repeat(32)}`

  it('derives what bind_staging_key derives', async () => {
    const secret = await stagingSecret(signature)
    expect(toHex(secret)).toBe('0x26f84e2ab5f45f1744f783f14b8ac6b1a2a2f5f63ca0b46e96e5748c6b638848')
    expect(toHex(stagingCommitment(secret, 7n))).toBe('0x12dbeab5cedbd4dd2987b522ffaf0718330b4aa49695d2e52a23428e69a0f001')
    // The recovery byte is not part of the secret.
    expect(await stagingSecret(`${signature}1b`)).toBe(secret)
  })

  it('differs per signature, round and counter', async () => {
    const a = await stagingSecret(signature)
    const b = await stagingSecret(`0x${'11'.repeat(32)}${'23'.repeat(32)}`)
    expect(a).not.toBe(b)
    expect(stagingCommitment(a, 7n)).not.toBe(stagingCommitment(a, 8n))
    expect(new Set([votesStagingTag(a, 7n, 0), votesStagingTag(a, 7n, 1), votesStagingTag(a, 8n, 0)]).size).toBe(3)
  })
})

describe('stagingKeyBinding', () => {
  const args = { e3Id: E3_ID, l1ChainId: 11155111, program: PROGRAM, slot: account.address as Address }

  it('recovers the slot key from the typed-data signature and derives the secret from it', async () => {
    let full: Hex = '0x'
    const capture: TypedDataSigner = async (typedData) => (full = await signer(typedData))
    const binding = await stagingKeyBinding({ ...args, signer: capture })
    const publicKey = Buffer.from(account.publicKey.slice(4), 'hex')
    expect(Buffer.from(binding.publicKeyX)).toEqual(publicKey.subarray(0, 32))
    expect(Buffer.from(binding.publicKeyY)).toEqual(publicKey.subarray(32, 64))
    expect(binding.signature).toHaveLength(64)
    expect(binding.secret).toBe(await stagingSecret(full))
    expect(binding.commitment).toBe(stagingCommitment(binding.secret, 7n))
    // A deterministic signer binds the same commitment every time: the reuse path needs no new transaction.
    expect((await stagingKeyBinding({ ...args, signer })).commitment).toBe(binding.commitment)
  })

  it('refuses a signature of another key', async () => {
    await expect(stagingKeyBinding({ ...args, slot: privateKeyToAccount(`0x${'01'.repeat(32)}`).address, signer })).rejects.toThrow(/not made by slot/)
  })
})

describe('staging tree', () => {
  const log = (index: number, commitment: bigint, root: bigint): StagingKeyBound => ({
    kind: 'StagingKeyBound',
    e3Id: E3_ID,
    roundId: 7n,
    index,
    slot: account.address,
    commitment,
    root,
  })

  it('is rebuilt from the logs and checked against the logged root', () => {
    const leaves = [5n, 6n, 7n]
    const tree = generateMerkleTree(leaves)
    const logs = leaves.map((leaf, i) => log(i, leaf, generateMerkleTree(leaves.slice(0, i + 1)).root!))
    expect(stagingTreeFromLogs([logs[2], logs[0], logs[1]]).root).toBe(tree.root)
    expect(() => stagingTreeFromLogs([logs[0], logs[2]])).toThrow(/missing/)
    expect(() => stagingTreeFromLogs([logs[0], { ...logs[1], root: 1n }])).toThrow(/differs/)
  })

  it('refuses a pass for a secret that is not bound, before proving', async () => {
    const tree = generateMerkleTree([5n])
    await expect(
      buildVotesStagingPass({
        secret: 99n,
        stagingTree: { leaves: [5n], root: tree.root!, tree },
        request: {
          l1ChainId: 11155111,
          program: PROGRAM,
          e3Id: E3_ID,
          ciphertextCommitment: `0x${'11'.repeat(32)}`,
          slot: account.address,
          parentIndexPlusOne: 0,
        },
        maxRequests: 4,
        counter: 0,
      }),
    ).rejects.toThrow(/not bound/)
  })
})

describe('stagingSecretStore', () => {
  it('keeps a secret per program, round and slot without touching any global storage', async () => {
    const data = new Map<string, string>()
    const store = stagingSecretStore({ get: (key) => data.get(key), set: (key, value) => void data.set(key, value) })
    expect(await store.get(PROGRAM, E3_ID, account.address)).toBeUndefined()
    await store.set(PROGRAM, E3_ID, account.address, 123456789n)
    expect(await store.get(PROGRAM, E3_ID, account.address)).toBe(123456789n)
    expect(await store.get(PROGRAM, E3_ID + 1n, account.address)).toBeUndefined()
    expect(await store.get(PROGRAM, E3_ID, privateKeyToAccount(`0x${'01'.repeat(32)}`).address)).toBeUndefined()
  })
})
