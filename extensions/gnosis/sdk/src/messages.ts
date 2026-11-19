// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { decodeAbiParameters, encodeAbiParameters, encodeFunctionData, parseAbi, type Address, type Hex } from 'viem'

import { MESSAGE_KIND } from './constants'

const ROUND_ID_BITS = 96n

/**
 * An Interfold e3Id is `interfold address (20 bytes) ‖ sequence (12 bytes)`. The messages carry the low 96 bits, the
 * `roundId`; Sepolia, the server and the digests a voter signs use the full e3Id.
 */
export const roundIdOf = (e3Id: bigint): bigint => e3Id & ((1n << ROUND_ID_BITS) - 1n)

/** The e3Id of round `roundId` of `interfold`: the inverse of {@link roundIdOf} for that Interfold. */
export const e3IdOf = (interfold: Address, roundId: bigint): bigint => {
  if (roundId >= 1n << ROUND_ID_BITS) throw new Error(`Round id ${roundId} does not fit 96 bits`)

  return (BigInt(interfold) << ROUND_ID_BITS) | roundId
}

/** The ROUND message `CRISPGnosisProgram` sends when a proposal is requested (`CRISPGnosisMessages.round`). */
export type RoundMessage = {
  roundId: bigint
  numOptions: bigint
  inputStart: bigint
  inputEnd: bigint
  inputLimit: bigint
  /** BFV plaintext modulus `t`. */
  plaintextModulus: bigint
  /** A Sepolia timestamp: the request time minus one. */
  snapshot: bigint
  censusMode: bigint
  censusRoot: Hex
  censusTotal: bigint
  proposalHash: Hex
  requester: Address
  metadataCid: string
}

const ROUND_TYPES = [
  { type: 'uint256' },
  { type: 'uint256' },
  { type: 'uint256' },
  { type: 'uint256' },
  { type: 'uint256' },
  { type: 'uint256' },
  { type: 'uint256' },
  { type: 'uint256' },
  { type: 'uint256' },
  { type: 'bytes32' },
  { type: 'uint256' },
  { type: 'bytes32' },
  { type: 'address' },
  { type: 'string' },
] as const

/** `abi.encode(1, roundId, numOptions, inputStart, inputEnd, inputLimit, t, snapshot, censusMode, censusRoot, censusTotal, proposalHash, requester, metadataCid)`. */
export const encodeRoundMessage = (m: RoundMessage): Hex =>
  encodeAbiParameters(ROUND_TYPES, [
    MESSAGE_KIND.ROUND,
    m.roundId,
    m.numOptions,
    m.inputStart,
    m.inputEnd,
    m.inputLimit,
    m.plaintextModulus,
    m.snapshot,
    m.censusMode,
    m.censusRoot,
    m.censusTotal,
    m.proposalHash,
    m.requester,
    m.metadataCid,
  ])

export const decodeRoundMessage = (message: Hex): RoundMessage => {
  const [kind, roundId, numOptions, inputStart, inputEnd, inputLimit, plaintextModulus, snapshot, censusMode, censusRoot, censusTotal, proposalHash, requester, metadataCid] =
    decodeAbiParameters(ROUND_TYPES, message)
  expectKind(kind, MESSAGE_KIND.ROUND)

  return { roundId, numOptions, inputStart, inputEnd, inputLimit, plaintextModulus, snapshot, censusMode, censusRoot, censusTotal, proposalHash, requester, metadataCid }
}

/** `abi.encode(2, roundId, committeePublicKey)`. */
export const encodeKeyMessage = (roundId: bigint, committeePublicKey: Hex): Hex =>
  encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'bytes32' }], [MESSAGE_KIND.KEY, roundId, committeePublicKey])

export const decodeKeyMessage = (message: Hex): { roundId: bigint; committeePublicKey: Hex } => {
  const [kind, roundId, committeePublicKey] = decodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'bytes32' }], message)
  expectKind(kind, MESSAGE_KIND.KEY)

  return { roundId, committeePublicKey }
}

/** `abi.encode(3, roundId, inputRoot, numInputs)`. */
export const encodeRootMessage = (roundId: bigint, inputRoot: bigint, numInputs: bigint): Hex =>
  encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }], [MESSAGE_KIND.ROOT, roundId, inputRoot, numInputs])

export const decodeRootMessage = (message: Hex): { roundId: bigint; inputRoot: bigint; numInputs: bigint } => {
  const [kind, roundId, inputRoot, numInputs] = decodeAbiParameters(
    [{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'uint256' }],
    message,
  )
  expectKind(kind, MESSAGE_KIND.ROOT)

  return { roundId, inputRoot, numInputs }
}

/** `abi.encode(4, roundId, tally)`. */
export const encodeResultMessage = (roundId: bigint, tally: readonly bigint[]): Hex =>
  encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256[]' }], [MESSAGE_KIND.RESULT, roundId, tally])

export const decodeResultMessage = (message: Hex): { roundId: bigint; tally: bigint[] } => {
  const [kind, roundId, tally] = decodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'uint256[]' }], message)
  expectKind(kind, MESSAGE_KIND.RESULT)

  return { roundId, tally: [...tally] }
}

const expectKind = (kind: bigint, expected: bigint): void => {
  if (kind !== expected) throw new Error(`Expected a message of kind ${expected}, got ${kind}`)
}

const receiverAbi = parseAbi(['function receiveMessage(bytes message)'])

/** The AMB `_data` that wraps every message (`IGnosisReceiver.receiveMessage`), both directions. */
export const encodeReceiveMessage = (message: Hex): Hex => encodeFunctionData({ abi: receiverAbi, functionName: 'receiveMessage', args: [message] })
