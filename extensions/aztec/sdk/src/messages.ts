// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { encodeAbiParameters, sha256, stringToBytes, type Address, type Hex } from 'viem'

import { MESSAGE_KIND } from './constants'

const ROUND_ID_BITS = 96n

/**
 * An Interfold e3Id is `interfold address (20 bytes) ‖ sequence (12 bytes)`, which does not fit an Aztec field. Everything
 * the L2 contract and the bridge carry is the low 96 bits, the `roundId`; the L1 program, the server and the digests a
 * voter signs use the full e3Id.
 */
export const roundIdOf = (e3Id: bigint): bigint => e3Id & ((1n << ROUND_ID_BITS) - 1n)

/** The e3Id of round `roundId` of `interfold`: the inverse of {@link roundIdOf} for that Interfold. */
export const e3IdOf = (interfold: Address, roundId: bigint): bigint => {
  if (roundId >= 1n << ROUND_ID_BITS) throw new Error(`Round id ${roundId} does not fit 96 bits`)

  return (BigInt(interfold) << ROUND_ID_BITS) | roundId
}

/** Round configuration the L1 program hands to the Aztec contract (`CRISPRemoteMessages.RoundConfig`). */
export type RoundConfig = {
  roundId: bigint
  numOptions: bigint
  credits: bigint
  inputStart: bigint
  inputEnd: bigint
  inputLimit: bigint
  scopeHash: bigint
  minAge: bigint
  allowMockDocuments: boolean
}

/** Aztec's `sha256_to_field`: SHA-256 with the top byte dropped, so the result fits a field element. */
export const sha256ToField = (data: Hex | Uint8Array): bigint => BigInt(sha256(data)) >> 8n

const words = (count: number) => Array.from({ length: count }, () => ({ type: 'uint256' }) as const)

/** `abi.encode(1, roundId, numOptions, credits, inputStart, inputEnd, inputLimit, scopeHash, minAge, allowMock)`. */
export const encodeRoundMessage = (c: RoundConfig): Hex =>
  encodeAbiParameters(words(10), [
    MESSAGE_KIND.ROUND,
    c.roundId,
    c.numOptions,
    c.credits,
    c.inputStart,
    c.inputEnd,
    c.inputLimit,
    c.scopeHash,
    c.minAge,
    c.allowMockDocuments ? 1n : 0n,
  ])

/** `abi.encode(2, roundId, committeePublicKey)`. */
export const encodeKeyMessage = (roundId: bigint, committeePublicKey: Hex): Hex =>
  encodeAbiParameters([{ type: 'uint256' }, { type: 'uint256' }, { type: 'bytes32' }], [MESSAGE_KIND.KEY, roundId, committeePublicKey])

/** `abi.encode(3, roundId, inputRoot, numInputs)`. */
export const encodeRootMessage = (roundId: bigint, inputRoot: bigint, numInputs: bigint): Hex =>
  encodeAbiParameters(words(4), [MESSAGE_KIND.ROOT, roundId, inputRoot, numInputs])

/** The field element the bridge carries for each message: `sha256ToField` of its encoding. */
export const roundContent = (config: RoundConfig): bigint => sha256ToField(encodeRoundMessage(config))
export const keyContent = (roundId: bigint, committeePublicKey: Hex): bigint => sha256ToField(encodeKeyMessage(roundId, committeePublicKey))
export const rootContent = (roundId: bigint, inputRoot: bigint, numInputs: bigint): bigint =>
  sha256ToField(encodeRootMessage(roundId, inputRoot, numInputs))

/** Scope string a ZKPassport proof is bound to (`CRISPAztecProgram.scopeOf`); it carries the full e3Id. */
export const scopeOf = (l1ChainId: bigint | number, program: Address, e3Id: bigint): string =>
  `crisp-aztec:${l1ChainId}:${program.toLowerCase()}:${e3Id}`

/** `uint256(sha256(bytes(scope))) >> 8`: the scope hash the round config carries (`CRISPRemoteProgram.scopeHashOf`). */
export const scopeHashOf = (l1ChainId: bigint | number, program: Address, e3Id: bigint): bigint =>
  sha256ToField(stringToBytes(scopeOf(l1ChainId, program, e3Id)))
