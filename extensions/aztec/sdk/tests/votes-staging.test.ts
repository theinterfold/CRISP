// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { getAddress, toHex, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { TypedDataSigner } from '../src/ballot'
import { e3IdOf } from '../src/messages'
import type { InputAttestation } from '../src/server'
import { stageWithNextPass, stagingCommitment, stagingKeyBinding, stagingSecret } from '../src/votes-staging'

const INTERFOLD = getAddress('0xdFa59d66c173A00643eBE80e172Af5a8Cf244b30')
const PROGRAM = getAddress('0x25Df8D3C04D67efb6198E215963d19a8d119ADFF')
const E3_ID = e3IdOf(INTERFOLD, 7n)
const KEY: Hex = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80'
const account = privateKeyToAccount(KEY)
const signer: TypedDataSigner = (typedData) => account.signTypedData(typedData as never)

describe('staging secret', () => {
  it('derives what bind_staging_key derives', async () => {
    // `staging_secret` / `staging_commitment` of `crisp_aztec_votes` for r = 0x11..11, s = 0x22..22, round 7.
    const signature: Hex = `0x${'11'.repeat(32)}${'22'.repeat(32)}`
    const secret = await stagingSecret(signature)
    expect(toHex(secret)).toBe('0x26f84e2ab5f45f1744f783f14b8ac6b1a2a2f5f63ca0b46e96e5748c6b638848')
    expect(toHex(stagingCommitment(secret, 7n))).toBe('0x12dbeab5cedbd4dd2987b522ffaf0718330b4aa49695d2e52a23428e69a0f001')
    // The recovery byte is not part of the secret.
    expect(await stagingSecret(`${signature}1b`)).toBe(secret)
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

describe('stageWithNextPass', () => {
  // The server's refusals, as `stageInput` reports them.
  const refused = (reason: string) => `CRISP server input staging failed (400): ${reason}`
  const TAG_USED = refused('The staging pass was already used')
  const UNKNOWN_ROOT = refused('The staging pass names a census root this round has not had')
  const attestation = { inputId: '0x01' } as unknown as InputAttestation

  afterEach(() => void vi.useRealTimers())

  /** Stage against a server that answers attempt `n` with `answers[n]`: a refusal, or `undefined` to accept. Pass `k`'s proof is `0x0k`. */
  const run = (answers: (string | undefined)[], maxRequests = 4) => {
    const sent: Hex[] = []
    const result = stageWithNextPass({
      counter: 0,
      maxRequests,
      prove: async (counter) => ({ proof: `0x0${counter}`, publicInputs: [] }),
      stage: async ({ proof }) => {
        const refusal = answers[sent.push(proof) - 1]
        if (refusal) throw new Error(refusal)
        return attestation
      },
    })

    return { sent, result }
  }

  it('proves the next pass when the server already holds the tag, and reports the counter that staged', async () => {
    const { sent, result } = run([TAG_USED, TAG_USED, undefined])
    expect(await result).toEqual({ attestation, counter: 2 })
    expect(sent).toEqual(['0x00', '0x01', '0x02'])
  })

  it('sends the same pass again while the server has not read its root, for three minutes', async () => {
    vi.useFakeTimers()
    const accepted = run([UNKNOWN_ROOT, UNKNOWN_ROOT, undefined])
    await vi.advanceTimersByTimeAsync(10_000)
    expect(await accepted.result).toEqual({ attestation, counter: 0 })
    expect(accepted.sent).toEqual(['0x00', '0x00', '0x00'])

    const never = run(Array(100).fill(UNKNOWN_ROOT))
    const failure = expect(never.result).rejects.toThrow(/has not had/)
    await vi.advanceTimersByTimeAsync(3 * 60_000)
    await failure
  })

  it('stops at any other refusal, and when every pass is used', async () => {
    await expect(run([refused('The staging pass proof is invalid')]).result).rejects.toThrow(/proof is invalid/)
    await expect(run([TAG_USED, TAG_USED], 2).result).rejects.toThrow(/used all 2 passes/)
  })
})
