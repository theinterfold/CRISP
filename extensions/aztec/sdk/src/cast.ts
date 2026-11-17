// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { CrispSDK, getZeroVote, type ProofOptions, type Vote } from '@crisp-e3/sdk'
import { bytesToHex, hexToBytes, keccak256, recoverAddress, type Address, type Hex } from 'viem'

import { availabilityDigest, ballotDigest, inputId } from './ballot'
import type { Census } from './census'
import { stageInput, type InputAttestation } from './server'

/** What a voter signs: the EIP-712 ballot digest, raw (no EIP-191 prefix), with the key of the slot address. */
export type DigestSigner = (digest: Hex) => Promise<Hex>

export type BuildCastInputs = {
  serverUrl: string
  /** The CRISP program on L1: the EIP-712 verifying contract of the ballot and of the attestation. */
  program: Address
  l1ChainId: number
  e3Id: bigint
  /** The voter's slot: an EVM address registered in the census. */
  slot: Address
  /** Credits each census member holds in this round. */
  credits: bigint
  numOptions: number
  census: Census
  /** The committee's BFV public key, as the CRISP server serves it. */
  committeePublicKey: Uint8Array
  /** The 32-byte commitment of that key the contract stored from the KEY message. */
  committeeKeyCommitment: Hex
  /** The availability signer the server is configured with; an attestation by anyone else is refused. */
  availabilitySigner: Address
  /** Omit for a mask: a mask carries no signature and is indistinguishable from a vote on chain. */
  ballot?: { vote: Vote; sign: DigestSigner }
  onProgress?: ProofOptions['onProgress']
}

/** Everything `cast` takes, in contract terms. */
export type CastArguments = {
  e3Id: bigint
  /** 115-field verification key and 458-field proof of the `noir-recursive` fold proof. */
  vk: bigint[]
  proof: bigint[]
  slot: Address
  ctCommitment: Hex
  encryptedVoteHash: Hex
  parentIndexPlusOne: number
  prevCommitment: bigint
  censusRoot: bigint
  expiresAt: bigint
  /** 64-byte `r ‖ s`. */
  signature: Hex
  /** The ciphertext, staged with the server; kept for the caller's own bookkeeping. */
  encryptedVote: Uint8Array
  attestation: InputAttestation
}

// Fold public inputs, in the order `CRISPProgram._verifyInputProof` reads them.
const PI = { PREV_COMMITMENT: 0, SLOT: 3, CENSUS_ROOT: 4, NUM_OPTIONS: 6, CT_COMMITMENT: 7, COMMITTEE_KEY: 8 } as const

/**
 * Build the arguments of one `cast` call: encrypt, sign, prove (a `noir-recursive` fold proof), stage the ciphertext
 * with the server, and check each value the contract will check so a mistake fails here, not in a rejected transaction.
 *
 * The circuit preset must be registered first (`setCircuits(await loadCircuits())` from the preset subpath of
 * `@crisp-e3/sdk` that matches the round).
 */
export const buildCast = async (inputs: BuildCastInputs): Promise<CastArguments> => {
  const { serverUrl, program, l1ChainId, e3Id, slot, census } = inputs
  const crisp = new CrispSDK(serverUrl)

  const prepared = await crisp.prepareBallot({
    censusMode: 'merkle',
    e3Id,
    slotAddress: slot,
    publicKey: inputs.committeePublicKey,
    merkleLeaves: census.leaves,
    balance: inputs.credits,
    numOptions: inputs.numOptions,
    isMaskVote: !inputs.ballot,
    vote: inputs.ballot?.vote ?? getZeroVote(inputs.numOptions),
  })

  const digest = ballotDigest({ l1ChainId, program, e3Id, slot, ciphertextCommitment: prepared.ctCommitment })
  const signature = inputs.ballot ? await inputs.ballot.sign(digest) : undefined
  const result = await crisp.finishBallot(prepared, digest, signature, { verifierTarget: 'noir-recursive', onProgress: inputs.onProgress })
  if (!result.recursive) throw new Error('The fold proof carries no recursive artifacts')

  const pi = result.publicInputs.map((value) => BigInt(value))
  if (pi.length !== 9) throw new Error(`The fold proof has ${pi.length} public inputs, expected 9`)
  if (pi[PI.CENSUS_ROOT] !== census.root)
    throw new Error('The proof was made against a different census root than the one rebuilt from the logs')
  if (pi[PI.COMMITTEE_KEY] !== BigInt(inputs.committeeKeyCommitment)) {
    throw new Error('The committee public key the server serves does not match the key the Aztec contract stored')
  }
  if (pi[PI.CT_COMMITMENT] !== BigInt(prepared.ctCommitment))
    throw new Error('The proof commits to a different ciphertext than the one prepared')

  const encryptedVoteHash = keccak256(bytesToHex(result.encryptedVote))
  const attestation = await stageInput(serverUrl, {
    e3Id,
    slot,
    ciphertext: result.encryptedVote,
    ciphertextCommitment: prepared.ctCommitment,
    parentIndexPlusOne: result.parentIndexPlusOne,
  })

  const id = inputId({
    program,
    e3Id,
    encryptedVoteHash,
    commitment: prepared.ctCommitment,
    slot,
    parentIndexPlusOne: result.parentIndexPlusOne,
  })
  if (attestation.inputId !== id || attestation.encryptedVoteHash !== encryptedVoteHash) {
    throw new Error('The server attested a different input than the one built')
  }
  const digestSigned = availabilityDigest({ l1ChainId, program, e3Id, inputId: id, expiresAt: attestation.expiresAt })
  if (!(await isSignedBy(digestSigned, attestation.signature, inputs.availabilitySigner))) {
    throw new Error('The attestation is not signed by the availability signer')
  }

  return {
    e3Id,
    vk: result.recursive.vkFields.map((field) => BigInt(field)),
    proof: result.recursive.proofFields.map((field) => BigInt(field)),
    slot,
    ctCommitment: prepared.ctCommitment,
    encryptedVoteHash,
    parentIndexPlusOne: result.parentIndexPlusOne,
    prevCommitment: pi[PI.PREV_COMMITMENT],
    censusRoot: census.root,
    expiresAt: attestation.expiresAt,
    signature: attestation.signature,
    encryptedVote: result.encryptedVote,
    attestation,
  }
}

/** A 64-byte `r ‖ s` signature carries no recovery id, so try both parities. */
const isSignedBy = async (digest: Hex, compact: Hex, signer: Address): Promise<boolean> => {
  if (hexToBytes(compact).length !== 64) throw new Error('The attestation signature must be 64 bytes (r ‖ s)')
  for (const v of ['1b', '1c']) {
    const recovered = await recoverAddress({ hash: digest, signature: `${compact}${v}` })
    if (recovered.toLowerCase() === signer.toLowerCase()) return true
  }
  return false
}
