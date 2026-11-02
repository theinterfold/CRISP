// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { beforeEach, describe, expect, it, vi } from 'vitest'

import type * as Round from '../src/round'
import type * as State from '../src/state'
import type { DaReader } from '../src/da'
import type { PrepareBallotRequest } from '../src/types'
import { CrispSDK } from '../src/sdk'

const mocks = vi.hoisted(() => ({
  prepareBallot: vi.fn(async (request: object) => ({ request })),
  getPreviousCiphertext: vi.fn(),
  getRoundDetails: vi.fn(async () => ({ chainId: 11155111n })),
  getSlotHead: vi.fn(),
  getSlotStatus: vi.fn(),
}))

vi.mock('../src/vote', async (importOriginal) => ({ ...(await importOriginal<object>()), prepareBallot: mocks.prepareBallot }))
vi.mock('../src/state', async (importOriginal) => ({
  ...(await importOriginal<typeof State>()),
  getPreviousCiphertext: mocks.getPreviousCiphertext,
  getRoundDetails: mocks.getRoundDetails,
}))
vi.mock('../src/slotHead', () => ({ getSlotHead: mocks.getSlotHead }))
vi.mock('../src/round', async (importOriginal) => ({ ...(await importOriginal<typeof Round>()), getSlotStatus: mocks.getSlotStatus }))

const SERVER = 'https://crisp.example'
const RPC = 'https://rpc.example'
const PROGRAM = '0x00000000000000000000000000000000000000c0'
const SLOT = '0x00000000000000000000000000000000000000aa'
const daReader: DaReader = { read: async () => new Uint8Array() }
const head = { ciphertext: Uint8Array.of(1, 2, 3), index: 4 }

// Only what path selection reads. The ballot itself is not exercised here.
const request = (extra: Partial<PrepareBallotRequest> = {}) =>
  ({ e3Id: 9n, slotAddress: SLOT, vote: [1, 0], numOptions: 2, ...extra }) as unknown as PrepareBallotRequest

const sentToEncryption = () => mocks.prepareBallot.mock.calls[0][0]

describe('CrispSDK.prepareBallot slot head', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getPreviousCiphertext.mockResolvedValue(undefined)
    mocks.getSlotHead.mockResolvedValue(undefined)
    mocks.getSlotStatus.mockResolvedValue({ active: false, entries: 0 })
  })

  describe('with a daReader', () => {
    it('reads the head from the chain and never calls the server', async () => {
      mocks.getSlotHead.mockResolvedValue(head)
      const sdk = new CrispSDK({ serverUrl: SERVER, rpcUrl: RPC, daReader })

      await sdk.prepareBallot(request({ programAddress: PROGRAM, chainId: 11155111 }))

      expect(mocks.getSlotHead).toHaveBeenCalledWith({
        programAddress: PROGRAM,
        e3Id: 9n,
        slot: SLOT,
        chainId: 11155111,
        rpcUrl: RPC,
        daReader,
      })
      expect(mocks.getPreviousCiphertext).not.toHaveBeenCalled()
      expect(mocks.getRoundDetails).not.toHaveBeenCalled()
      expect(sentToEncryption()).toMatchObject({ previousCiphertext: head.ciphertext, previousIndex: 4 })
    })

    it('prepares a first vote when the slot holds nothing usable', async () => {
      const sdk = new CrispSDK({ rpcUrl: RPC, daReader })

      await sdk.prepareBallot(request({ programAddress: PROGRAM, chainId: 1 }))

      expect(sentToEncryption()).not.toHaveProperty('previousCiphertext')
      expect(sentToEncryption()).not.toHaveProperty('previousIndex')
    })

    it('takes the chain id from the server when the request has none', async () => {
      const sdk = new CrispSDK({ serverUrl: SERVER, daReader })

      await sdk.prepareBallot(request({ programAddress: PROGRAM }))

      expect(mocks.getRoundDetails).toHaveBeenCalledWith(SERVER, 9n)
      expect(mocks.getSlotHead).toHaveBeenCalledWith(expect.objectContaining({ chainId: 11155111 }))
    })

    it('needs a chain id when there is no server to ask', async () => {
      const sdk = new CrispSDK({ daReader })

      await expect(sdk.prepareBallot(request({ programAddress: PROGRAM }))).rejects.toThrow('needs request.chainId')
      expect(mocks.prepareBallot).not.toHaveBeenCalled()
    })

    it('needs the program address', async () => {
      const sdk = new CrispSDK({ serverUrl: SERVER, daReader })

      await expect(sdk.prepareBallot(request())).rejects.toThrow('needs request.programAddress')
      expect(mocks.getPreviousCiphertext).not.toHaveBeenCalled()
    })

    it('does not fall back to the server when the chain read fails', async () => {
      mocks.getSlotHead.mockRejectedValue(new Error('Avail is down'))
      const sdk = new CrispSDK({ serverUrl: SERVER, daReader })

      await expect(sdk.prepareBallot(request({ programAddress: PROGRAM, chainId: 1 }))).rejects.toThrow('Avail is down')
      expect(mocks.getPreviousCiphertext).not.toHaveBeenCalled()
      expect(mocks.prepareBallot).not.toHaveBeenCalled()
    })
  })

  describe('with a server and no daReader', () => {
    it('asks the server for the head', async () => {
      mocks.getPreviousCiphertext.mockResolvedValue(head)
      const sdk = new CrispSDK(SERVER, RPC)

      await sdk.prepareBallot(request())

      expect(mocks.getPreviousCiphertext).toHaveBeenCalledWith(SERVER, 9n, SLOT)
      expect(mocks.getSlotHead).not.toHaveBeenCalled()
      expect(mocks.getSlotStatus).not.toHaveBeenCalled()
      expect(sentToEncryption()).toMatchObject({ previousCiphertext: head.ciphertext, previousIndex: 4 })
    })

    it('prepares a first vote when the server reports an empty slot', async () => {
      await new CrispSDK(SERVER).prepareBallot(request())

      expect(sentToEncryption()).not.toHaveProperty('previousCiphertext')
    })
  })

  describe('with neither a server nor a daReader', () => {
    it('treats the slot as empty when the chain shows no entry', async () => {
      const sdk = new CrispSDK({ rpcUrl: RPC })

      await sdk.prepareBallot(request({ programAddress: PROGRAM, chainId: 11155111 }))

      expect(mocks.getSlotStatus).toHaveBeenCalledWith({ programAddress: PROGRAM, e3Id: 9n, slot: SLOT, chainId: 11155111, rpcUrl: RPC })
      expect(sentToEncryption()).not.toHaveProperty('previousCiphertext')
    })

    it('refuses an occupied slot rather than dropping the voter’s re-vote', async () => {
      mocks.getSlotStatus.mockResolvedValue({ active: true, entries: 2 })
      const sdk = new CrispSDK({ rpcUrl: RPC })

      await expect(sdk.prepareBallot(request({ programAddress: PROGRAM, chainId: 11155111 }))).rejects.toThrow(
        /already holds 2 entries.*serverUrl or a daReader/,
      )
      expect(mocks.prepareBallot).not.toHaveBeenCalled()
    })

    it('cannot check emptiness without knowing where the round is', async () => {
      const sdk = new CrispSDK({ rpcUrl: RPC })

      await expect(sdk.prepareBallot(request())).rejects.toThrow('emptiness cannot be checked')
      await expect(sdk.prepareBallot(request({ programAddress: PROGRAM }))).rejects.toThrow('needs request.chainId')
      expect(mocks.prepareBallot).not.toHaveBeenCalled()
    })
  })
})
