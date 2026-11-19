// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { BlockNumber } from '@aztec-labs/foundation/branded-types'
import { Fr } from '@aztec-labs/foundation/curves/bn254'
import type { AztecAddress } from '@aztec-labs/stdlib/aztec-address'
import type { AztecNode } from '@aztec-labs/stdlib/interfaces/client'
import { type LogResult, queryAllPublicLogsByTags, Tag } from '@aztec-labs/stdlib/logs'
import { getAddress, numberToHex, type Address, type Hex } from 'viem'

import { LOG_TAG } from './constants'
import { e3IdOf } from './messages'

/** Where a log was emitted. */
export type LogOrigin = {
  blockNumber: number
  txHash: string
  blockTimestamp: bigint
  txIndexWithinBlock: number
  logIndexWithinTx: number
}

/** `[1, round_id, index, slot, ct_commitment, vote_hash_hi, vote_hash_lo, parent_index_plus_one]` */
export type InputCommitted = {
  kind: 'InputCommitted'
  e3Id: bigint
  roundId: bigint
  index: number
  slot: Address
  ctCommitment: Hex
  /** `keccak256(ciphertext)`, rebuilt from its two u128 halves. */
  encryptedVoteHash: Hex
  parentIndexPlusOne: number
}
/** `[2, round_id, census_index, slot, census_leaf, census_root]` */
export type MemberRegistered = {
  kind: 'MemberRegistered'
  e3Id: bigint
  roundId: bigint
  censusIndex: number
  slot: Address
  censusLeaf: bigint
  censusRoot: bigint
}
/** `[3, round_id, input_root, num_inputs]` */
export type RoundClosed = { kind: 'RoundClosed'; e3Id: bigint; roundId: bigint; inputRoot: bigint; numInputs: number }
/** `[4, round_id]` */
export type RoundOpened = { kind: 'RoundOpened'; e3Id: bigint; roundId: bigint }
/** `[5, round_id, committee_public_key]` */
export type KeyPublished = { kind: 'KeyPublished'; e3Id: bigint; roundId: bigint; committeePublicKey: Hex }

export type CrispLog = InputCommitted | MemberRegistered | RoundClosed | RoundOpened | KeyPublished
export type WithOrigin<T> = T & { origin: LogOrigin }

const U128 = (1n << 128n) - 1n
const hex32 = (value: bigint): Hex => numberToHex(value, { size: 32 })
const address = (value: bigint): Address => getAddress(numberToHex(value, { size: 20 }))

const expectLength = (tag: number, fields: readonly bigint[], length: number) => {
  if (fields.length < length) throw new Error(`Public log ${tag} carries ${fields.length} fields, expected ${length}`)
}

/** Decode the fields of one CRISP public log, the tag first. The contract logs the round id; `interfold` turns it into the e3Id. */
export const decodeLog = (fields: readonly bigint[], interfold: Address): CrispLog => {
  const ids = () => ({ e3Id: e3IdOf(interfold, fields[1]), roundId: fields[1] })
  const tag = Number(fields[0])
  switch (tag) {
    case LOG_TAG.INPUT_COMMITTED:
      expectLength(tag, fields, 8)
      return {
        kind: 'InputCommitted',
        ...ids(),
        index: Number(fields[2]),
        slot: address(fields[3]),
        ctCommitment: hex32(fields[4]),
        encryptedVoteHash: hex32(((fields[5] & U128) << 128n) | (fields[6] & U128)),
        parentIndexPlusOne: Number(fields[7]),
      }
    case LOG_TAG.MEMBER_REGISTERED:
      expectLength(tag, fields, 6)
      return {
        kind: 'MemberRegistered',
        ...ids(),
        censusIndex: Number(fields[2]),
        slot: address(fields[3]),
        censusLeaf: fields[4],
        censusRoot: fields[5],
      }
    case LOG_TAG.ROUND_CLOSED:
      expectLength(tag, fields, 4)
      return { kind: 'RoundClosed', ...ids(), inputRoot: fields[2], numInputs: Number(fields[3]) }
    case LOG_TAG.ROUND_OPENED:
      expectLength(tag, fields, 2)
      return { kind: 'RoundOpened', ...ids() }
    case LOG_TAG.KEY_PUBLISHED:
      expectLength(tag, fields, 3)
      return { kind: 'KeyPublished', ...ids(), committeePublicKey: hex32(fields[2]) }
    default:
      throw new Error(`Unknown CRISP public log tag ${tag}`)
  }
}

const withOrigin = (log: LogResult, interfold: Address): WithOrigin<CrispLog> => ({
  ...decodeLog(
    log.logData.map((field) => field.toBigInt()),
    interfold,
  ),
  origin: {
    blockNumber: Number(log.blockNumber),
    txHash: log.txHash.toString(),
    blockTimestamp: BigInt(log.blockTimestamp),
    txIndexWithinBlock: log.txIndexWithinBlock,
    logIndexWithinTx: log.logIndexWithinTx,
  },
})

export type ReadLogsOptions = {
  /** First L2 block to read, inclusive. */
  fromBlock?: number
  /** Last L2 block to read, exclusive. */
  toBlock?: number
}

type ByTag = { [K in CrispLog['kind']]: Extract<CrispLog, { kind: K }> }

const TAG_OF: { [K in CrispLog['kind']]: number } = {
  InputCommitted: LOG_TAG.INPUT_COMMITTED,
  MemberRegistered: LOG_TAG.MEMBER_REGISTERED,
  RoundClosed: LOG_TAG.ROUND_CLOSED,
  RoundOpened: LOG_TAG.ROUND_OPENED,
  KeyPublished: LOG_TAG.KEY_PUBLISHED,
}

/**
 * Read every log of one kind the contract emitted, oldest first, optionally for the round with this e3Id.
 *
 * Logs are located by their tag (the first field), and the node pages them for us. The filter by round is
 * applied here because the tag does not include it.
 */
export const readLogs = async <K extends CrispLog['kind']>(
  node: Pick<AztecNode, 'getPublicLogsByTags'>,
  contract: AztecAddress,
  kind: K,
  interfold: Address,
  options: ReadLogsOptions & { e3Id?: bigint } = {},
): Promise<WithOrigin<ByTag[K]>[]> => {
  const [logs] = await queryAllPublicLogsByTags(node, {
    contractAddress: contract,
    tags: [new Tag(new Fr(BigInt(TAG_OF[kind])))],
    fromBlock: options.fromBlock === undefined ? undefined : BlockNumber(options.fromBlock),
    toBlock: options.toBlock === undefined ? undefined : BlockNumber(options.toBlock),
  })

  return logs
    .map((log) => withOrigin(log, interfold))
    .filter((log) => options.e3Id === undefined || log.e3Id === options.e3Id) as WithOrigin<ByTag[K]>[]
}
