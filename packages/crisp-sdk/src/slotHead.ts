// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { bytesToHex, getAddress, parseAbiItem } from 'viem'

import { getPublicClient } from './chain'
import { readVerified } from './da'
import { getZkInputsGenerator } from './encoding'
import { slotHeadIndex } from './headRule'
import { scanLogs } from './logs'
import { getInputStartBlock } from './round'

import type { Address, Hex } from 'viem'
import type { DaEntry, DaReader } from './da'
import type { HeadEntry } from './headRule'
import type { SlotHead } from './types'

const inputCommittedEvent = parseAbiItem(
  'event InputCommitted(uint256 indexed e3Id, bytes32 indexed inputId, address indexed slotAddress, bytes32 encryptedVoteCommitment, bytes32 encryptedVoteHash, uint40 parentIndexPlusOne, uint40 index)',
)

const inputPublishedEvent = parseAbiItem(
  'event InputPublished(uint256 indexed e3Id, address indexed slotAddress, bytes32 encryptedVoteCommitment, bytes32 encryptedVoteHash, uint32 availabilityBlock, uint128 availabilityLeafIndex, uint256 index, uint40 parentIndexPlusOne)',
)

/**
 * One entry of a slot, as the chain records it. `InputCommitted` reserves the tree index and fixes
 * the commitment, hash and parent; `InputPublished` adds the availability coordinates once the
 * data-availability receipt is verified. An entry with no coordinates is still pending.
 */
export type SlotEntry = HeadEntry & DaEntry & { commitment: Hex }

/**
 * What {@link getSlotHead} reads and from where.
 */
export type GetSlotHeadParams = {
  /** The CRISPProgram contract. */
  programAddress: string
  e3Id: bigint
  /** The slot whose head to resolve: the address a ballot is written to. */
  slot: string
  /** The chain the program is deployed on. */
  chainId: number
  /** Endpoint to read through; omitted, viem's default public RPC for the chain is used. */
  rpcUrl?: string
  /** Where ciphertext bytes come from. Every byte read is checked against the on-chain hash. */
  daReader: DaReader
  /**
   * First block to scan for the slot's events. Defaults to the block at which the round started
   * accepting inputs (`E3.inputWindow[0]`), before which no entry can exist. Pass it when you
   * already know a tighter bound, such as the round's request block.
   */
  fromBlock?: bigint
  /** Last block to scan. Defaults to the chain head. */
  toBlock?: bigint
  /** Blocks per `eth_getLogs` request; see `scanLogs`. */
  chunkSize?: bigint
}

/**
 * The entries of one slot, merged from `InputCommitted` and `InputPublished` and ordered by tree
 * index. Both events are read because an entry is a valid parent from the moment it is committed,
 * hours before its receipt lands.
 */
export const getSlotEntries = async ({
  programAddress,
  e3Id,
  slot,
  chainId,
  rpcUrl,
  fromBlock,
  toBlock,
  chunkSize,
}: Omit<GetSlotHeadParams, 'daReader'>): Promise<SlotEntry[]> => {
  const client = getPublicClient(chainId, rpcUrl)
  const address = programAddress as Address
  const slotAddress = getAddress(slot)

  const start = fromBlock ?? (await getInputStartBlock({ programAddress, e3Id, chainId, rpcUrl }))

  const scan = { address, args: { e3Id, slotAddress }, fromBlock: start, toBlock, chunkSize }
  const [committed, published] = await Promise.all([
    scanLogs(client, { ...scan, event: inputCommittedEvent }),
    scanLogs(client, { ...scan, event: inputPublishedEvent }),
  ])

  const entries = new Map<number, SlotEntry>()

  const merge = (entry: Omit<SlotEntry, 'e3Id' | 'slot'>) => {
    const known = entries.get(entry.index)
    if (
      known &&
      (known.commitment !== entry.commitment ||
        known.encryptedVoteHash !== entry.encryptedVoteHash ||
        known.parentIndexPlusOne !== entry.parentIndexPlusOne)
    ) {
      // The contract binds all three into the input id, so the two events cannot differ.
      throw new Error(`InputCommitted and InputPublished disagree about tree index ${entry.index}`)
    }
    entries.set(entry.index, { ...known, ...entry, e3Id, slot: slotAddress })
  }

  for (const { args } of committed) {
    merge({
      index: Number(args.index),
      commitment: args.encryptedVoteCommitment,
      encryptedVoteHash: args.encryptedVoteHash,
      parentIndexPlusOne: Number(args.parentIndexPlusOne),
    })
  }
  for (const { args } of published) {
    merge({
      index: Number(args.index),
      commitment: args.encryptedVoteCommitment,
      encryptedVoteHash: args.encryptedVoteHash,
      parentIndexPlusOne: Number(args.parentIndexPlusOne),
      availabilityBlock: args.availabilityBlock,
      availabilityLeafIndex: args.availabilityLeafIndex,
    })
  }

  return [...entries.values()].sort((a, b) => a.index - b.index)
}

/**
 * Whether bytes reproduce a commitment, which is what makes an entry usable. The server decides
 * this when it indexes an entry (`compute_ct_commitment`); the Secure Process decides it again
 * for the tally. Bytes that do not deserialize into a ciphertext are simply unusable.
 */
const reproducesCommitment = (bytes: Uint8Array, commitment: Hex): boolean => {
  try {
    return bytesToHex(getZkInputsGenerator().computeCtCommitment(bytes), { size: 32 }) === commitment.toLowerCase()
  } catch {
    return false
  }
}

/**
 * Resolve the head of a slot straight from the chain and a data-availability layer.
 *
 * The head is the entry a new input must name as its parent: the end of the slot's chain of usable
 * entries under the Secure Process's rule (see `headRule.ts`). It is the same answer the CRISP
 * server gives at `state/previous-ciphertext`, without asking the server.
 *
 * The slot's `InputCommitted` and `InputPublished` events give each entry's tree index, parent,
 * commitment and hash. Bytes are fetched through `daReader`, checked against the on-chain
 * `keccak256`, and hashed into a commitment with the registered BFV preset — so the preset must
 * match the round's parameters, as it must to build a ballot. Only entries that could become the
 * head are fetched: those whose parent is the head at their turn.
 *
 * Fails rather than guesses. A reader error, bytes that fail the hash check, or an entry still
 * waiting for its Avail receipt that the reader cannot supply all throw: dropping such an entry
 * could name a stale parent, and an input that names one is dropped from the tally.
 *
 * Reads the chain head, so an entry in a block that is later reorganized away can be seen. Pass
 * `toBlock` for a finalized bound when that matters.
 *
 * @returns The head's ciphertext and tree index, or `undefined` when the slot holds nothing usable
 */
export const getSlotHead = async (params: GetSlotHeadParams): Promise<SlotHead | undefined> => {
  const entries = await getSlotEntries(params)
  const bytesOf = new Map<number, Uint8Array>()

  const index = await slotHeadIndex(entries, params.slot, async (entry) => {
    let bytes: Uint8Array
    try {
      bytes = await readVerified(params.daReader, entry)
    } catch (error) {
      const state = entry.availabilityBlock === undefined ? ' (its availability receipt is not on chain yet)' : ''
      throw new Error(`Cannot read the ciphertext of entry ${entry.index}${state}: ${error instanceof Error ? error.message : error}`)
    }

    const usable = reproducesCommitment(bytes, entry.commitment)
    if (usable) bytesOf.set(entry.index, bytes)
    return usable
  })

  return index === undefined ? undefined : { ciphertext: bytesOf.get(index) as Uint8Array, index }
}
