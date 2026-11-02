// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { decodeAbiParameters, hexToBytes, keccak256, parseAbi, parseAbiItem, parseAbiParameters } from 'viem'

import { getPublicClient } from './chain'
import { blockAtTimestamp, scanLogs } from './logs'

import type { Address, Hex } from 'viem'

// Everything in this file is a plain chain read (viem only, no wasm), so it is also exported from
// the light `@crisp-e3/sdk/chain` entry.

const coordinatorAbi = parseAbi([
  'struct E3 { uint256 seed; uint8 committeeSize; uint256 requestBlock; uint256[2] inputWindow; bytes32 encryptionSchemeId; address e3Program; uint8 paramSet; bytes customParams; address decryptionVerifier; address pkVerifier; bytes32 committeePublicKey; bytes32 ciphertextOutput; bytes plaintextOutput; address requester; bytes32 ciphertextCommitment; }',
  'function getE3(uint256 e3Id) view returns (E3)',
  'function getE3Stage(uint256 e3Id) view returns (uint8)',
  'function paramSetRegistry(uint8 paramSet) view returns (bytes)',
  'function ciphernodeRegistry() view returns (address)',
])

const programAbi = parseAbi([
  'function inputCommitmentDeadline(uint256 e3Id) view returns (uint256)',
  'function interfold() view returns (address)',
])

const committeePublishedEvent = parseAbiItem(
  'event CommitteePublished(uint256 indexed e3Id, address[] nodes, bytes publicKey, bytes32 pkCommitment, bytes proof)',
)

const committeeKeyChunkEvent = parseAbiItem(
  'event CommitteePublicKeyChunkPublished(uint256 indexed e3Id, address indexed publisher, bytes32 indexed candidateHash, address[] nodes, bytes32 pkCommitment, uint16 chunkIndex, uint16 chunkCount, uint32 totalLength, bytes chunk)',
)

const inputCommittedEvent = parseAbiItem(
  'event InputCommitted(uint256 indexed e3Id, bytes32 indexed inputId, address indexed slotAddress, bytes32 encryptedVoteCommitment, bytes32 encryptedVoteHash, uint40 parentIndexPlusOne, uint40 index)',
)

/**
 * Candidates considered before giving up.
 *
 * Verifying one runs a wasm BFV deserialization over up to 512 KB of publisher-supplied bytes, so
 * a round spammed with candidates must not be able to freeze the caller.
 */
export const MAX_COMMITTEE_KEY_CANDIDATES = 20

/** The Interfold `E3Stage` enum, by name, in contract order. */
export const ROUND_STAGES = ['None', 'Requested', 'CommitteeFinalized', 'KeyPublished', 'CiphertextReady', 'Complete', 'Failed'] as const

/** A round's lifecycle stage on the Interfold coordinator. */
export type RoundStage = (typeof ROUND_STAGES)[number]

/** Where to read from. */
export type ChainReadOptions = {
  /** The chain the contracts are deployed on. */
  chainId: number
  /** Endpoint to read through. Omitted, viem's default public RPC for the chain is used. */
  rpcUrl?: string
}

/** Identifies a round on its Interfold coordinator. */
export type RoundReadOptions = ChainReadOptions & {
  /** The Interfold coordinator address (`interfold_address` in the server's round state). */
  interfoldAddress: string
  /** The e3Id of the round. */
  e3Id: bigint
}

/** The BFV parameters a round runs under, as registered on the coordinator. */
export type RoundBfvParams = {
  degree: bigint
  plaintextModulus: bigint
  moduli: readonly bigint[]
}

/**
 * A round's state as the chain holds it.
 */
export type RoundState = {
  /** The e3Id of the round. */
  e3Id: bigint
  /** The coordinator's lifecycle stage. */
  stage: RoundStage
  /** Unix seconds at which inputs open and at which the round stops taking inputs. */
  inputWindow: { start: bigint; end: bigint }
  /**
   * Unix seconds at or after which `CRISPProgram` refuses a new input commitment. This is earlier
   * than `inputWindow.end` by the program's availability finalization window, and it is the cutoff
   * the server reports as the round's `end_time`. `undefined` while the round has no program yet.
   */
  commitmentDeadline: bigint | undefined
  /** Unix seconds at which the round was requested. The contract names it `requestBlock`. */
  requestTime: bigint
  /** The on-chain commitment to the committee key. All zero until the key is published. */
  committeePublicKeyCommitment: Hex
  /** The coordinator's parameter set id. */
  paramSet: number
  /** The E3 program of the round: the `CRISPProgram` address. */
  e3Program: Address
  /**
   * Whether the chain would accept a new input commitment right now: the committee key is
   * published (`KeyPublished`) and the time is within `[inputWindow.start, commitmentDeadline)`.
   * These are `CRISPProgram`'s own checks for `publishInput`; per-slot checks (eligibility, input
   * limit) are not part of it.
   */
  acceptingInputs: boolean
}

/**
 * Read a round's stage, input window and key commitment from the Interfold coordinator, and
 * derive whether it is taking inputs.
 *
 * Replaces the server's `state/lite` for round readiness. The server tracks its own status
 * (`Requested`, `Active`, `Expired`, ...) from the same events; here the contract's checks are
 * applied directly, so the answer cannot lag an indexer.
 *
 * @param options - The coordinator, the round, the chain and, optionally, the clock
 * @param options.now - The time to judge the window against, in unix seconds. Defaults to the
 *                      timestamp of the chain's latest block.
 * @returns The round state
 */
export const getRoundState = async ({
  interfoldAddress,
  e3Id,
  chainId,
  rpcUrl,
  now,
}: RoundReadOptions & { now?: bigint }): Promise<RoundState> => {
  const client = getPublicClient(chainId, rpcUrl)
  const address = interfoldAddress as Address

  const [e3, stageIndex] = await Promise.all([
    client.readContract({ address, abi: coordinatorAbi, functionName: 'getE3', args: [e3Id] }),
    client.readContract({ address, abi: coordinatorAbi, functionName: 'getE3Stage', args: [e3Id] }),
  ])

  const stage = ROUND_STAGES[stageIndex]
  if (!stage) throw new Error(`Unknown stage ${stageIndex} for round ${e3Id}`)

  const [start, end] = e3.inputWindow
  const hasProgram = e3.e3Program !== '0x0000000000000000000000000000000000000000'

  const [commitmentDeadline, chainNow] = await Promise.all([
    hasProgram
      ? client.readContract({ address: e3.e3Program, abi: programAbi, functionName: 'inputCommitmentDeadline', args: [e3Id] })
      : undefined,
    now === undefined ? client.getBlock({ blockTag: 'latest' }).then((block) => block.timestamp) : now,
  ])

  return {
    e3Id,
    stage,
    inputWindow: { start, end },
    commitmentDeadline,
    requestTime: e3.requestBlock,
    committeePublicKeyCommitment: e3.committeePublicKey,
    paramSet: e3.paramSet,
    e3Program: e3.e3Program,
    acceptingInputs: stage === 'KeyPublished' && commitmentDeadline !== undefined && chainNow >= start && chainNow < commitmentDeadline,
  }
}

/**
 * Read the BFV parameters a round runs under from `paramSetRegistry` on the coordinator.
 *
 * The registry holds the exact blob the E3 program is configured with, so it is the authoritative
 * statement of the round's parameters; the numeric `paramSet` is only a registry key.
 *
 * @param options - The coordinator, the round and the chain
 * @returns The degree, plaintext modulus and moduli
 */
export const getRoundBfvParams = async ({ interfoldAddress, e3Id, chainId, rpcUrl }: RoundReadOptions): Promise<RoundBfvParams> => {
  const client = getPublicClient(chainId, rpcUrl)
  const address = interfoldAddress as Address

  const e3 = await client.readContract({ address, abi: coordinatorAbi, functionName: 'getE3', args: [e3Id] })
  const encoded = await client.readContract({ address, abi: coordinatorAbi, functionName: 'paramSetRegistry', args: [e3.paramSet] })
  if (!encoded || encoded === '0x') throw new Error(`Parameter set ${e3.paramSet} of round ${e3Id} is not registered on the coordinator`)

  const [[degree, plaintextModulus, moduli]] = decodeAbiParameters(parseAbiParameters('(uint256, uint256, uint256[], bytes)'), encoded)

  return { degree, plaintextModulus, moduli }
}

/**
 * A serialized committee public key that some publisher announced for a round.
 *
 * Not trustworthy on its own: any committee member can publish one. It is only the round's key if
 * its recomputed commitment equals the round's `committeePublicKeyCommitment`, which
 * {@link getCommitteePublicKey} checks.
 */
export type CommitteePublicKeyCandidate = {
  publicKey: Uint8Array
  /** `event` for a `CommitteePublished` blob, `chunks` for one reassembled from chunk events. */
  source: 'event' | 'chunks'
  /** The committee member who published the chunks, for `chunks` candidates. */
  publisher?: Address
}

/** One decoded `CommitteePublicKeyChunkPublished` log, reduced to what assembly needs. */
export type KeyChunkLog = {
  blockNumber: bigint
  logIndex: number
  publisher: Address
  candidateHash: Hex
  chunkIndex: number
  chunkCount: number
  totalLength: number
  chunk: Hex
}

/** A reassembled candidate, with the chain position of its first chunk for ordering. */
export type AssembledKey = Required<CommitteePublicKeyCandidate> & { blockNumber: bigint; logIndex: number }

/**
 * Reassemble chunked key candidates.
 *
 * Chunks are grouped by `(publisher, candidateHash)`, may arrive out of order (a member may
 * re-publish any chunk), and only a complete group whose bytes hash to `candidateHash` and whose
 * length equals `totalLength` is a candidate. The registry accepts chunks only from committee
 * members, and consumers take at most one candidate per member, so the first verified group of a
 * publisher is the only one kept.
 *
 * @param logs - The chunk logs, in chain order
 * @returns The assembled candidates, in the order their first chunk appeared
 */
export const assembleKeyChunks = (logs: readonly KeyChunkLog[]): AssembledKey[] => {
  const groups = new Map<string, { log: KeyChunkLog; chunks: Map<number, Hex> }>()

  for (const log of logs) {
    if (log.chunkIndex >= log.chunkCount) continue
    const id = `${log.publisher.toLowerCase()}:${log.candidateHash}`
    const group = groups.get(id) ?? { log, chunks: new Map<number, Hex>() }
    // First wins: a differing re-publication of an index can only make this publisher's own
    // candidate fail its hash check, never another publisher's.
    if (!group.chunks.has(log.chunkIndex)) group.chunks.set(log.chunkIndex, log.chunk)
    groups.set(id, group)
  }

  const seenPublishers = new Set<string>()
  const assembled: AssembledKey[] = []

  for (const { log, chunks } of groups.values()) {
    const publisher = log.publisher.toLowerCase()
    if (seenPublishers.has(publisher) || chunks.size !== log.chunkCount) continue

    const parts: Uint8Array[] = []
    for (let index = 0; index < log.chunkCount; index++) {
      const chunk = chunks.get(index)
      if (!chunk) break
      parts.push(hexToBytes(chunk))
    }
    if (parts.length !== log.chunkCount) continue

    const publicKey = new Uint8Array(parts.reduce((length, part) => length + part.length, 0))
    let offset = 0
    for (const part of parts) {
      publicKey.set(part, offset)
      offset += part.length
    }

    if (publicKey.length !== log.totalLength || keccak256(publicKey) !== log.candidateHash) continue

    seenPublishers.add(publisher)
    assembled.push({ publicKey, source: 'chunks', publisher: log.publisher, blockNumber: log.blockNumber, logIndex: log.logIndex })
  }

  return assembled
}

/**
 * Collect the committee public key candidates announced on the ciphernode registry for a round.
 *
 * Reads `CommitteePublished` (the key as one blob) and `CommitteePublicKeyChunkPublished` (the
 * key in chunks, reassembled and checked against its keccak candidate hash) from the registry the
 * coordinator names. Candidates are deduplicated by content, kept in chain order, and capped at
 * `maxCandidates`, so a spammed round costs a bounded amount of verification.
 *
 * @param options - The coordinator, the round and the chain
 * @param options.fromBlock - First block to scan. Defaults to the block of the round's request;
 *                            Interfold stores that as a timestamp, which this converts.
 * @param options.toBlock - Last block to scan. Defaults to the chain head.
 * @param options.maxCandidates - Cap on returned candidates. Defaults to {@link MAX_COMMITTEE_KEY_CANDIDATES}.
 * @returns The candidates, none of them verified
 */
export const getCommitteePublicKeyCandidates = async ({
  interfoldAddress,
  e3Id,
  chainId,
  rpcUrl,
  fromBlock,
  toBlock,
  maxCandidates = MAX_COMMITTEE_KEY_CANDIDATES,
}: RoundReadOptions & { fromBlock?: bigint; toBlock?: bigint; maxCandidates?: number }): Promise<CommitteePublicKeyCandidate[]> => {
  const client = getPublicClient(chainId, rpcUrl)
  const coordinator = interfoldAddress as Address

  const registry = await client.readContract({ address: coordinator, abi: coordinatorAbi, functionName: 'ciphernodeRegistry' })
  const start =
    fromBlock ??
    (await blockAtTimestamp(
      client,
      (await client.readContract({ address: coordinator, abi: coordinatorAbi, functionName: 'getE3', args: [e3Id] })).requestBlock,
    ))

  const [published, chunked] = await Promise.all([
    scanLogs(client, { address: registry, event: committeePublishedEvent, args: { e3Id }, fromBlock: start, toBlock }),
    scanLogs(client, { address: registry, event: committeeKeyChunkEvent, args: { e3Id }, fromBlock: start, toBlock }),
  ])

  const entries: { block: bigint; logIndex: number; candidate: CommitteePublicKeyCandidate }[] = []

  for (const log of published) {
    if (log.args.publicKey === '0x') continue
    entries.push({
      block: log.blockNumber,
      logIndex: log.logIndex,
      candidate: { publicKey: hexToBytes(log.args.publicKey), source: 'event' },
    })
  }

  const chunkLogs = chunked.map((log) => ({
    blockNumber: log.blockNumber,
    logIndex: log.logIndex,
    publisher: log.args.publisher,
    candidateHash: log.args.candidateHash,
    chunkIndex: log.args.chunkIndex,
    chunkCount: log.args.chunkCount,
    totalLength: log.args.totalLength,
    chunk: log.args.chunk,
  }))
  for (const { blockNumber, logIndex, ...candidate } of assembleKeyChunks(chunkLogs)) {
    entries.push({ block: blockNumber, logIndex, candidate })
  }

  entries.sort((a, b) => (a.block === b.block ? a.logIndex - b.logIndex : a.block < b.block ? -1 : 1))

  const seen = new Set<Hex>()
  const candidates: CommitteePublicKeyCandidate[] = []
  for (const { candidate } of entries) {
    const digest = keccak256(candidate.publicKey)
    if (seen.has(digest)) continue
    seen.add(digest)
    candidates.push(candidate)
    if (candidates.length >= maxCandidates) break
  }

  return candidates
}

/**
 * Whether a slot already holds an entry, read from the chain.
 *
 * A slot is *active* when it has at least one `InputCommitted` event: the program reserves the
 * slot's tree index at commit time, so this is the earliest the chain reveals an entry. The
 * server's `voting/status` `slot_active` is the same fact seen later — it flips once the server
 * holds the entry's ciphertext bytes, which can trail the commitment while data availability
 * finalizes. As there, activity is not "this address voted": anyone can mask any eligible slot.
 */
export type SlotStatus = {
  /** Whether the slot has any committed entry. */
  active: boolean
  /** How many entries have been committed to the slot, superseded ones included. */
  entries: number
}

/**
 * The first block in which an input can be committed to a round: the block at which its input
 * window opens. The program names its coordinator, so only the program address is needed.
 *
 * @param options.programAddress - The `CRISPProgram` address
 * @param options.e3Id - The e3Id of the round
 * @returns The block number
 */
export const getInputStartBlock = async ({
  programAddress,
  e3Id,
  chainId,
  rpcUrl,
}: ChainReadOptions & { programAddress: string; e3Id: bigint }): Promise<bigint> => {
  const client = getPublicClient(chainId, rpcUrl)
  const coordinator = await client.readContract({ address: programAddress as Address, abi: programAbi, functionName: 'interfold' })
  const e3 = await client.readContract({ address: coordinator, abi: coordinatorAbi, functionName: 'getE3', args: [e3Id] })

  return blockAtTimestamp(client, e3.inputWindow[0])
}

/**
 * Read whether a slot holds any committed entry.
 *
 * @param options.programAddress - The `CRISPProgram` address
 * @param options.e3Id - The e3Id of the round
 * @param options.slot - The slot address
 * @param options.fromBlock - First block to scan. Defaults to {@link getInputStartBlock}.
 * @param options.toBlock - Last block to scan. Defaults to the chain head.
 * @returns The slot status
 */
export const getSlotStatus = async ({
  programAddress,
  e3Id,
  slot,
  chainId,
  rpcUrl,
  fromBlock,
  toBlock,
}: ChainReadOptions & {
  programAddress: string
  e3Id: bigint
  slot: string
  fromBlock?: bigint
  toBlock?: bigint
}): Promise<SlotStatus> => {
  const client = getPublicClient(chainId, rpcUrl)

  const logs = await scanLogs(client, {
    address: programAddress as Address,
    event: inputCommittedEvent,
    args: { e3Id, slotAddress: slot as Address },
    fromBlock: fromBlock ?? (await getInputStartBlock({ programAddress, e3Id, chainId, rpcUrl })),
    toBlock,
  })

  return { active: logs.length > 0, entries: logs.length }
}
