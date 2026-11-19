// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { concat, encodeAbiParameters, hashDomain, hashTypedData, keccak256, numberToHex, pad, sha256, type Address, type Hex } from 'viem'

import { SNARK_SCALAR_FIELD } from './constants'

/**
 * The EIP-712 domain of both signed statements of a round: the ballot and the input-availability attestation.
 * Identical to `CRISPProgram`'s, with the Aztec program as the verifying contract.
 */
export const crispDomain = (l1ChainId: bigint | number, program: Address) =>
  ({ name: 'CRISP', version: '1', chainId: BigInt(l1ChainId), verifyingContract: program }) as const

/** EIP-712 domain separator of {@link crispDomain}; the Aztec contract stores it as an immutable for both statements. */
export const domainSeparator = (l1ChainId: bigint | number, program: Address): Hex =>
  hashDomain({
    domain: crispDomain(l1ChainId, program),
    types: {
      EIP712Domain: [
        { name: 'name', type: 'string' },
        { name: 'version', type: 'string' },
        { name: 'chainId', type: 'uint256' },
        { name: 'verifyingContract', type: 'address' },
      ],
    },
  })

const BALLOT_TYPES = {
  Ballot: [
    { name: 'e3Id', type: 'uint256' },
    { name: 'slot', type: 'address' },
    { name: 'ciphertextCommitment', type: 'bytes32' },
  ],
} as const

const AVAILABILITY_TYPES = {
  InputAvailability: [
    { name: 'e3Id', type: 'uint256' },
    { name: 'inputId', type: 'bytes32' },
    { name: 'expiresAt', type: 'uint64' },
  ],
} as const

/** `CRISPProgram.ballotDigest`: what the slot owner signs, and what the fold proof exposes as `digest_hi/lo`. */
export const ballotDigest = (args: {
  l1ChainId: bigint | number
  program: Address
  e3Id: bigint
  slot: Address
  ciphertextCommitment: Hex
}): Hex =>
  hashTypedData({
    domain: crispDomain(args.l1ChainId, args.program),
    types: BALLOT_TYPES,
    primaryType: 'Ballot',
    message: { e3Id: args.e3Id, slot: args.slot, ciphertextCommitment: args.ciphertextCommitment },
  })

/** `CRISPProgram.inputAvailabilityDigest`: what the availability service signs once it has stored the ciphertext. */
export const availabilityDigest = (args: {
  l1ChainId: bigint | number
  program: Address
  e3Id: bigint
  inputId: Hex
  expiresAt: bigint
}): Hex =>
  hashTypedData({
    domain: crispDomain(args.l1ChainId, args.program),
    types: AVAILABILITY_TYPES,
    primaryType: 'InputAvailability',
    message: { e3Id: args.e3Id, inputId: args.inputId, expiresAt: args.expiresAt },
  })

/** `CRISPProgram.inputId`: identifies one input; a replay of the same ballot yields the same id. */
export const inputId = (args: {
  program: Address
  e3Id: bigint
  encryptedVoteHash: Hex
  commitment: Hex
  slot: Address
  parentIndexPlusOne: number
}): Hex =>
  keccak256(
    encodeAbiParameters(
      [
        { type: 'string' },
        { type: 'address' },
        { type: 'uint256' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'address' },
        { type: 'uint40' },
      ],
      ['CRISP_INPUT_V1', args.program, args.e3Id, args.encryptedVoteHash, args.commitment, args.slot, args.parentIndexPlusOne],
    ),
  )

/**
 * `CRISPProgram.inputLeaf`: the leaf an input occupies in the round's input tree, which is what the OpenVM guest
 * rebuilds. `sha256(encryptedVoteHash ‖ commitment ‖ slot ‖ uint40 parentIndexPlusOne)` over the 89-byte packed
 * preimage, reduced into the field.
 */
export const inputLeaf = (args: { encryptedVoteHash: Hex; commitment: Hex; slot: Address; parentIndexPlusOne: number }): bigint =>
  BigInt(
    sha256(
      concat([
        pad(args.encryptedVoteHash, { size: 32 }),
        pad(args.commitment, { size: 32 }),
        args.slot,
        numberToHex(args.parentIndexPlusOne, { size: 5 }),
      ]),
    ),
  ) % SNARK_SCALAR_FIELD
