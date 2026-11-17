// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { concat, encodeAbiParameters, keccak256, numberToHex, stringToHex, type Address } from 'viem'
import { describe, expect, it } from 'vitest'

import { availabilityDigest, ballotDigest, domainSeparator, inputId } from '../src/ballot'

const PROGRAM: Address = '0x1111111111111111111111111111111111111111'
const SLOT: Address = '0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266'
const COMMITMENT = '0x0fa7a80cec2504d63d25b556b08413a79ebd4747901c9c5ba2ab7a122a4d3e8d'
const CHAIN_ID = 31337

// The EIP-712 construction written out by hand, the way OpenZeppelin's EIP712 contract computes it.
const manualSeparator = () =>
  keccak256(
    encodeAbiParameters(
      [{ type: 'bytes32' }, { type: 'bytes32' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }],
      [
        keccak256(stringToHex('EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)')),
        keccak256(stringToHex('CRISP')),
        keccak256(stringToHex('1')),
        BigInt(CHAIN_ID),
        PROGRAM,
      ],
    ),
  )
const typed = (structHash: `0x${string}`) => keccak256(concat(['0x1901', manualSeparator(), structHash as `0x${string}`]))

describe('EIP-712 statements', () => {
  it('uses the OpenZeppelin domain separator of the L1 program address', () => {
    expect(domainSeparator(CHAIN_ID, PROGRAM)).toBe(manualSeparator())
  })

  it('digests the ballot like CRISPProgram.ballotDigest', () => {
    const structHash = keccak256(
      encodeAbiParameters(
        [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'address' }, { type: 'bytes32' }],
        [keccak256(stringToHex('Ballot(uint256 e3Id,address slot,bytes32 ciphertextCommitment)')), 7n, SLOT, COMMITMENT],
      ),
    )
    expect(ballotDigest({ l1ChainId: CHAIN_ID, program: PROGRAM, e3Id: 7n, slot: SLOT, ciphertextCommitment: COMMITMENT })).toBe(
      typed(structHash),
    )
  })

  it('digests the availability attestation like CRISPProgram.inputAvailabilityDigest', () => {
    const id = keccak256('0x01')
    const structHash = keccak256(
      encodeAbiParameters(
        [{ type: 'bytes32' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'uint64' }],
        [keccak256(stringToHex('InputAvailability(uint256 e3Id,bytes32 inputId,uint64 expiresAt)')), 7n, id, 1_700_000_000n],
      ),
    )
    expect(availabilityDigest({ l1ChainId: CHAIN_ID, program: PROGRAM, e3Id: 7n, inputId: id, expiresAt: 1_700_000_000n })).toBe(
      typed(structHash),
    )
  })

  it('identifies an input like CRISPProgram.inputId', () => {
    const encryptedVoteHash = keccak256('0x02')
    const expected = keccak256(
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
        ['CRISP_INPUT_V1', PROGRAM, 7n, encryptedVoteHash, COMMITMENT, SLOT, 3],
      ),
    )
    expect(inputId({ program: PROGRAM, e3Id: 7n, encryptedVoteHash, commitment: COMMITMENT, slot: SLOT, parentIndexPlusOne: 3 })).toBe(
      expected,
    )
    expect(numberToHex(3, { size: 5 })).toBe('0x0000000003')
  })
})
