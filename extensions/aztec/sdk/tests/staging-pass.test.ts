// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { generateMerkleTree, hashLeaf } from '@crisp-e3/sdk'
import { concat, getAddress, hexToBytes, pad, type Hex } from 'viem'
import { privateKeyToAccount, sign } from 'viem/accounts'
import { afterAll, describe, expect, it } from 'vitest'

import { stagingTreeFromLogs, type Census } from '../src/census'
import { e3IdOf, roundIdOf } from '../src/messages'
import {
  buildStagingPass,
  destroyStagingPassProver,
  stagingRequestDigest,
  stagingTag,
  type StagingPass,
  type StagingRequest,
} from '../src/staging-pass'
import { buildVotesStagingPass, destroyVotesStagingPassProver, stagingCommitment, votesStagingTag } from '../src/votes-staging'

// Hardhat's first accounts: the registered slots. The fourth is not registered.
const KEYS: Hex[] = [
  '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
]
const accounts = KEYS.map((key) => privateKeyToAccount(key))
const signerOf = (index: number) => (digest: Hex) => sign({ hash: digest, privateKey: KEYS[index], to: 'hex' })

const CREDITS = 1000n
const MAX_REQUESTS = 16
const INTERFOLD = getAddress('0xdFa59d66c173A00643eBE80e172Af5a8Cf244b30')
const PROGRAM = getAddress('0x25Df8D3C04D67efb6198E215963d19a8d119ADFF')
const E3_ID = e3IdOf(INTERFOLD, 7n)

const leaves = accounts.slice(0, 3).map((account) => hashLeaf(account.address, CREDITS))
const tree = generateMerkleTree(leaves)
const census: Census = { leaves, root: tree.root!, tree }

/** A mask: the request names slot 2, the pass is made with the masker's own key (slot 1). */
const request: StagingRequest = {
  l1ChainId: 11155111,
  program: PROGRAM,
  e3Id: E3_ID,
  ciphertextCommitment: '0x0000000000000000000000000000000000000000000000000000000000001234',
  slot: accounts[2].address,
  parentIndexPlusOne: 3,
}

/** The bb binary the CRISP server runs (6.0.0); `BB_BINARY` overrides the one on the PATH. */
const BB = process.env.BB_BINARY ?? 'bb'
const FIXTURES = join(__dirname, '../../../../server/tests/fixtures')
const VK = join(__dirname, '../../../core/circuits/staging_pass/compiled/staging_pass.vk')
const VOTES_VK = join(__dirname, '../../../core/circuits/staging_pass_votes/compiled/staging_pass_votes.vk')

/** `WRITE_STAGING_FIXTURE=1` refreshes the passes the server's Rust tests check (`server/tests/fixtures/<name>.json`). */
const writeFixture = (name: string, pass: StagingPass): void => {
  if (!process.env.WRITE_STAGING_FIXTURE) return
  writeFileSync(
    join(FIXTURES, `${name}.json`),
    `${JSON.stringify(
      {
        chain_id: Number(request.l1ChainId),
        program: request.program,
        e3_id: request.e3Id.toString(),
        slot: request.slot,
        ciphertext_commitment: request.ciphertextCommitment,
        parent_index_plus_one: request.parentIndexPlusOne,
        staging_pass: { proof: pass.proof, public_inputs: pass.publicInputs },
      },
      null,
      2,
    )}\n`,
  )
}

/** The same call the server makes: `bb verify` of the default target (`evm`) over raw proof and public-input files. */
const bbVerifies = (pass: StagingPass, vk = VK): boolean => {
  const dir = mkdtempSync(join(tmpdir(), 'staging-pass-'))
  try {
    writeFileSync(join(dir, 'proof'), hexToBytes(pass.proof))
    writeFileSync(join(dir, 'public_inputs'), hexToBytes(concat(pass.publicInputs)))
    execFileSync(BB, ['verify', '-p', join(dir, 'proof'), '-i', join(dir, 'public_inputs'), '-k', vk, '-t', 'evm'], { stdio: 'pipe' })
    return true
  } catch {
    return false
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

afterAll(async () => {
  await destroyStagingPassProver()
  await destroyVotesStagingPassProver()
})

describe('staging pass', () => {
  it('binds the request digest and the tag layout the server recomputes', () => {
    // Pinned so the Rust `staging_request_digest` can be checked against the same value.
    expect(stagingRequestDigest(request)).toBe('0xca0aaea375f27d277735c8c4aa967c4d37bb594235dc9af4c7f055700fc54acf')
    expect(roundIdOf(E3_ID)).toBe(7n)
  })

  it('makes a pass for another slot that the server verifier accepts, and refuses a tampered one', async () => {
    const started = performance.now()
    const pass = await buildStagingPass({ signer: signerOf(1), census, credits: CREDITS, request, maxRequests: MAX_REQUESTS, counter: 0 })
    console.info(`staging pass proved in ${((performance.now() - started) / 1000).toFixed(1)}s`)

    const [root, round, hi, lo, max, tag] = pass.publicInputs.map((field) => BigInt(field))
    const digest = BigInt(stagingRequestDigest(request))
    expect(root).toBe(census.root)
    expect(round).toBe(7n)
    expect((hi << 128n) | lo).toBe(digest)
    expect(max).toBe(BigInt(MAX_REQUESTS))
    const publicKey = hexToBytes(accounts[1].publicKey)
    expect(tag).toBe(stagingTag(publicKey.slice(1, 33), publicKey.slice(33, 65), 7n, 0))

    expect(bbVerifies(pass)).toBe(true)

    writeFixture('staging_pass', pass)

    // A flipped proof byte.
    const bytes = hexToBytes(pass.proof)
    bytes[bytes.length >> 1] ^= 1
    expect(bbVerifies({ ...pass, proof: `0x${Buffer.from(bytes).toString('hex')}` })).toBe(false)
    // Public inputs the proof was not made for: another tag, another request digest.
    const swapped = (index: number, value: bigint): StagingPass => ({
      ...pass,
      publicInputs: pass.publicInputs.map((field, i) => (i === index ? pad(`0x${value.toString(16)}`, { size: 32 }) : field)),
    })
    expect(bbVerifies(swapped(5, tag + 1n))).toBe(false)
    expect(bbVerifies(swapped(3, lo ^ 1n))).toBe(false)
    expect(bbVerifies(swapped(0, root + 1n))).toBe(false)
  }, 300_000)

  it('makes a votes pass for a bound staging secret that the server verifier accepts', async () => {
    const secret = 0x1234n
    const commitments = [5n, stagingCommitment(secret, 7n), 6n]
    // The tree as a client reads it: from the STAGING_KEY_BOUND logs, each with the root after its own insertion.
    const stagingTree = stagingTreeFromLogs(
      commitments.map((commitment, index) => ({
        kind: 'StagingKeyBound',
        e3Id: E3_ID,
        roundId: 7n,
        index,
        slot: accounts[index].address,
        commitment,
        root: generateMerkleTree(commitments.slice(0, index + 1)).root!,
      })),
    )
    const pass = await buildVotesStagingPass({ secret, stagingTree, request, maxRequests: MAX_REQUESTS, counter: 3 })

    // The order the server reads them in.
    const [root, round, hi, lo, max, tag] = pass.publicInputs.map((field) => BigInt(field))
    expect(root).toBe(stagingTree.root)
    expect(round).toBe(7n)
    expect((hi << 128n) | lo).toBe(BigInt(stagingRequestDigest(request)))
    expect(max).toBe(BigInt(MAX_REQUESTS))
    expect(tag).toBe(votesStagingTag(secret, 7n, 3))
    expect(bbVerifies(pass, VOTES_VK)).toBe(true)
    writeFixture('staging_pass_votes', pass)
  }, 300_000)

  it('keeps the tags of one key apart per counter and per round', () => {
    const key = hexToBytes(accounts[0].publicKey)
    const [x, y] = [key.slice(1, 33), key.slice(33, 65)]
    const tags = new Set([stagingTag(x, y, 7n, 0), stagingTag(x, y, 7n, 1), stagingTag(x, y, 8n, 0)])
    expect(tags.size).toBe(3)
    expect(stagingTag(x, y, 7n, 0)).toBe(stagingTag(x, y, 7n, 0))
  })

  it('refuses a key that is not registered and a counter past the limit before proving', async () => {
    await expect(
      buildStagingPass({ signer: signerOf(3), census, credits: CREDITS, request, maxRequests: MAX_REQUESTS, counter: 0 }),
    ).rejects.toThrow(/not registered/)
    await expect(
      buildStagingPass({ signer: signerOf(1), census, credits: CREDITS, request, maxRequests: MAX_REQUESTS, counter: MAX_REQUESTS }),
    ).rejects.toThrow(/outside/)
  })
})
