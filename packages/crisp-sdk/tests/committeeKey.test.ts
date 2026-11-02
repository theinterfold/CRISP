// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { beforeAll, describe, expect, it, vi } from 'vitest'
import { ZKInputsGenerator } from '@crisp-e3/zk-inputs'
import { bytesToHex, encodeAbiParameters, keccak256, parseAbiParameters } from 'viem'

import { getCommitteePublicKey, isCommitteeKeyAuthentic } from '../src/committeeKey'

import type { Address, Hex } from 'viem'
import type { RoundBfvParams } from '../src/round'

const COORDINATOR = '0x00000000000000000000000000000000000000c0' as Address
const REGISTRY = '0x00000000000000000000000000000000000000d0' as Address
const PROGRAM = '0x00000000000000000000000000000000000000e0' as Address
const E3_ID = (1n << 200n) + 7n

const client = vi.hoisted(() => ({ current: undefined as unknown }))

vi.mock('../src/chain', () => ({ getPublicClient: () => client.current }))

describe('committee public key', () => {
  let params: RoundBfvParams
  let keyA: Uint8Array
  let keyB: Uint8Array
  let commitmentA: Hex
  let commitmentB: Hex

  beforeAll(() => {
    const generator = ZKInputsGenerator.fromPreset('insecure-64')
    const raw = generator.getBFVParams() as { degree: number; plaintextModulus: bigint; moduli: bigint[] }
    params = { degree: BigInt(raw.degree), plaintextModulus: raw.plaintextModulus, moduli: raw.moduli }

    keyA = generator.generateKeys().publicKey
    keyB = generator.generateKeys().publicKey
    commitmentA = bytesToHex(generator.computePkCommitment(keyA))
    commitmentB = bytesToHex(generator.computePkCommitment(keyB))
  })

  describe('isCommitteeKeyAuthentic', () => {
    it('accepts the key whose commitment it is', () => {
      expect(isCommitteeKeyAuthentic(keyA, commitmentA, params)).toBe(true)
      expect(isCommitteeKeyAuthentic(keyB, commitmentB, params)).toBe(true)
    })

    it('is case-insensitive about the expected commitment', () => {
      expect(isCommitteeKeyAuthentic(keyA, commitmentA.toUpperCase().replace('0X', '0x'), params)).toBe(true)
    })

    it('rejects a different key, bytes that are not a key, and an empty key', () => {
      expect(commitmentA).not.toBe(commitmentB)
      expect(isCommitteeKeyAuthentic(keyA, commitmentB, params)).toBe(false)
      expect(
        isCommitteeKeyAuthentic(
          Uint8Array.from({ length: 64 }, (_, i) => i),
          commitmentA,
          params,
        ),
      ).toBe(false)
      expect(isCommitteeKeyAuthentic(new Uint8Array(), commitmentA, params)).toBe(false)
    })

    it('rejects an unset or malformed commitment', () => {
      expect(isCommitteeKeyAuthentic(keyA, '0x' + '00'.repeat(32), params)).toBe(false)
      expect(isCommitteeKeyAuthentic(keyA, '0x1234', params)).toBe(false)
      expect(isCommitteeKeyAuthentic(keyA, 'not hex', params)).toBe(false)
    })

    it('throws for parameters that are not a supported preset instead of reporting a mismatch', () => {
      const unsupported = { ...params, plaintextModulus: params.plaintextModulus + 2n }
      expect(() => isCommitteeKeyAuthentic(keyA, commitmentA, unsupported)).toThrow()
    })
  })

  describe('getCommitteePublicKey', () => {
    const install = ({ commitment, stage = 3, events }: { commitment: Hex; stage?: number; events: Hex[] }) => {
      const registryEntry = encodeAbiParameters(parseAbiParameters('(uint256, uint256, uint256[], bytes)'), [
        [params.degree, params.plaintextModulus, [...params.moduli], '0x'],
      ])

      client.current = {
        readContract: async ({ functionName }: { functionName: string }) => {
          switch (functionName) {
            case 'getE3':
              return {
                inputWindow: [0n, 10n ** 12n],
                e3Program: PROGRAM,
                requestBlock: 1_000n,
                committeePublicKey: commitment,
                paramSet: 0,
              }
            case 'getE3Stage':
              return stage
            case 'inputCommitmentDeadline':
              return 10n ** 12n
            case 'paramSetRegistry':
              return registryEntry
            case 'ciphernodeRegistry':
              return REGISTRY
            default:
              throw new Error(`unexpected read ${functionName}`)
          }
        },
        getBlock: async (a: { blockTag?: 'latest'; blockNumber?: bigint }) => ({
          number: a.blockTag === 'latest' ? 99n : a.blockNumber,
          timestamp: 1_000n + (a.blockNumber ?? 99n),
        }),
        getBlockNumber: async () => 99n,
        getLogs: async ({ event }: { event: { name: string } }) =>
          event.name === 'CommitteePublished'
            ? events.map((publicKey, i) => ({ blockNumber: BigInt(i), logIndex: 0, args: { e3Id: E3_ID, publicKey } }))
            : [],
      }
    }

    const read = () => getCommitteePublicKey({ interfoldAddress: COORDINATOR, e3Id: E3_ID, chainId: 1 })

    it('returns the first candidate that matches the commitment, skipping junk and other keys', async () => {
      install({ commitment: commitmentA, events: ['0xdeadbeef', bytesToHex(keyB), bytesToHex(keyA)] })

      expect(await read()).toEqual(keyA)
    })

    it('throws when no candidate matches', async () => {
      install({ commitment: commitmentA, events: ['0xdeadbeef', bytesToHex(keyB)] })

      await expect(read()).rejects.toThrow(/None of the 2 committee key candidate\(s\)/)
    })

    it('throws when nothing was published', async () => {
      install({ commitment: commitmentA, events: [] })

      await expect(read()).rejects.toThrow(/No committee key has been published/)
    })

    it('throws before scanning when the round has no commitment yet', async () => {
      install({ commitment: ('0x' + '00'.repeat(32)) as Hex, stage: 2, events: [bytesToHex(keyA)] })

      await expect(read()).rejects.toThrow(/no committee key commitment on-chain yet \(stage CommitteeFinalized\)/)
    })

    it('does not accept a key whose hash merely equals the commitment', async () => {
      install({ commitment: keccak256(keyA), events: [bytesToHex(keyA)] })

      await expect(read()).rejects.toThrow(/None of the 1 committee key candidate/)
    })
  })
})
