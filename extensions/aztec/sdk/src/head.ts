// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { CrispSDK, slotHeadIndex, type SlotHead } from '@crisp-e3/sdk'
import { bytesToHex, hexToBytes, keccak256, type Address, type Hex } from 'viem'

import type { RoundClient } from './roundClient'
import type { SecretStorage } from './votes-staging'

/**
 * Ciphertexts this client staged, by round and `keccak256`. A re-vote extends the slot's head, whose bytes only the voter (and,
 * once an Aztec epoch is proven, the server) holds: keeping them lets a voter change their vote straight away. Backed by a
 * caller-supplied `{ get, set }` (a `localStorage` wrapper, a file, …); the SDK touches no global storage.
 */
export const ciphertextStore = (storage: SecretStorage) => {
  const key = (e3Id: bigint, hash: Hex) => `crisp-aztec:ciphertext:v1:${e3Id}:${hash.toLowerCase()}`

  return {
    async get(e3Id: bigint, hash: Hex): Promise<Uint8Array | undefined> {
      const stored = await storage.get(key(e3Id, hash))

      return stored ? hexToBytes(stored as Hex) : undefined
    },
    /** Keep `ciphertext` (the `encryptedVote` of a `cast`) once it has been sent. */
    async set(e3Id: bigint, ciphertext: Uint8Array): Promise<void> {
      await storage.set(key(e3Id, keccak256(ciphertext)), bytesToHex(ciphertext))
    },
  }
}

export type CiphertextStore = ReturnType<typeof ciphertextStore>

export type ResolveSlotHeadInputs = {
  /** `CrispAztec` or `CrispAztecVotes`: only its contract's logs are read. */
  client: Pick<RoundClient, 'logs'>
  e3Id: bigint
  slot: Address
  /** Where the bytes of a head this client staged are kept; tried first. */
  cache?: CiphertextStore
  /** The CRISP server: serves the head once its epoch is proven. */
  serverUrl: string
}

/**
 * The entry that holds `slot`: the end of its chain of committed inputs, read from the contract's public logs (which show an
 * input the moment its block exists, hours before the server's proven view), with its bytes from `cache` or, failing that, from
 * the server. `undefined` for an empty slot. A new input has to name this entry as its parent or the tally drops it, so a head
 * whose bytes cannot be found is an error, never an empty slot. Pass the result as `buildCast`'s `head`.
 */
export const resolveSlotHead = async (inputs: ResolveSlotHeadInputs): Promise<SlotHead | undefined> => {
  const { client, e3Id, slot } = inputs
  const logs = (await client.logs('InputCommitted', { e3Id })).filter((log) => log.slot.toLowerCase() === slot.toLowerCase())
  const index = await slotHeadIndex(
    logs.map((log) => ({ index: log.index, slot: log.slot, parentIndexPlusOne: log.parentIndexPlusOne })),
    slot,
    () => true,
  )
  if (index === undefined) return undefined
  const entry = logs.find((log) => log.index === index)!

  const cached = await inputs.cache?.get(e3Id, entry.encryptedVoteHash)
  if (cached && keccak256(cached) === entry.encryptedVoteHash) return { ciphertext: cached, index }

  const head = await new CrispSDK(inputs.serverUrl).getPreviousCiphertext(e3Id, slot)
  if (!head || head.index !== index || keccak256(bytesToHex(head.ciphertext)) !== entry.encryptedVoteHash) {
    throw new Error(
      `Slot ${slot}'s latest ballot (input ${index}) is on Aztec, but its bytes are neither stored on this client nor served by the CRISP server yet: ` +
        'the server reads Aztec once an epoch is proven, about one to two hours after the ballot. Try again later.',
    )
  }

  return head
}
