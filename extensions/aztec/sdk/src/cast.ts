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
import { buildStagingPass } from './staging-pass'

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
  /**
   * The committee's BFV public key, as the CRISP server serves it. The contract checks that the ballot is encrypted to the
   * key it stored from the KEY message, from the commitments the two encryption proofs expose.
   */
  committeePublicKey: Uint8Array
  /** The availability signer the server is configured with; an attestation by anyone else is refused. */
  availabilitySigner: Address
  /** Omit for a mask: a mask carries no signature and is indistinguishable from a vote on chain. */
  ballot?: { vote: Vote; sign: DigestSigner }
  /**
   * The staging pass of this request (`staging-pass.ts`): signed by the voter's OWN registered slot key, for a vote and a mask
   * alike, so the server cannot tell them apart. For a vote that is the ballot's signer; for a mask `slot` is the masked
   * slot and this is the masker's.
   */
  staging: {
    signer: DigestSigner
    /** The server's `staging_max_requests`. */
    maxRequests: number
    /** The next unused pass counter of the signer's key in this round (`BuildStagingPassInputs.counter`). */
    counter: number
  }
  onProgress?: ProofOptions['onProgress']
}

/** Everything `cast` takes, in contract terms. */
export type CastArguments = {
  e3Id: bigint
  /**
   * The three base proofs of the ballot, which `cast` verifies in place of L1's fold: each a 115-field verification
   * key and a 410-field `noir-recursive-no-zk` proof, with the public inputs of the two encryption proofs.
   */
  ct0Vk: bigint[]
  ct0Proof: bigint[]
  ct0PublicInputs: bigint[]
  ct1Vk: bigint[]
  ct1Proof: bigint[]
  ct1PublicInputs: bigint[]
  crispVk: bigint[]
  crispProof: bigint[]
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

// Public inputs of the crisp ballot proof, in the order the circuit declares them (the first eight are the fold's too).
const PI = { PREV_COMMITMENT: 0, SLOT: 3, CENSUS_ROOT: 4, NUM_OPTIONS: 6, CT_COMMITMENT: 7 } as const

/**
 * Build the arguments of one `cast` call: encrypt, sign, prove the three base circuits (no aggregation: the contract
 * verifies them itself), stage the ciphertext with the server, and check each value the contract will check so a mistake
 * fails here, not in a rejected transaction. The proofs stay on this device: only the ciphertext and its commitment go
 * to the server, and the proofs are arguments of a private function, hidden by the Aztec transaction proof.
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
  const result = await crisp.finishBallotBase(prepared, digest, signature, { onProgress: inputs.onProgress })

  const pi = result.crisp.publicInputs.map((value) => BigInt(value))
  if (pi.length !== 10) throw new Error(`The crisp proof has ${pi.length} public inputs, expected 10`)
  if (result.ct0.publicInputs.length !== 4 || result.ct1.publicInputs.length !== 3) {
    throw new Error('The encryption proofs have an unexpected number of public inputs')
  }
  if (pi[PI.CENSUS_ROOT] !== census.root)
    throw new Error('The proof was made against a different census root than the one rebuilt from the logs')
  if (pi[PI.CT_COMMITMENT] !== BigInt(prepared.ctCommitment))
    throw new Error('The proof commits to a different ciphertext than the one prepared')

  const encryptedVoteHash = keccak256(bytesToHex(result.encryptedVote))
  const staged = {
    e3Id,
    slot,
    ciphertext: result.encryptedVote,
    ciphertextCommitment: prepared.ctCommitment,
    parentIndexPlusOne: result.parentIndexPlusOne,
  }
  const stagingPass = await buildStagingPass({
    ...inputs.staging,
    census,
    credits: inputs.credits,
    request: { l1ChainId, program, ...staged },
  })
  const attestation = await stageInput(serverUrl, { ...staged, stagingPass })

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
    ct0Vk: toBigints(result.ct0.vkFields),
    ct0Proof: toBigints(result.ct0.proofFields),
    ct0PublicInputs: toBigints(result.ct0.publicInputs),
    ct1Vk: toBigints(result.ct1.vkFields),
    ct1Proof: toBigints(result.ct1.proofFields),
    ct1PublicInputs: toBigints(result.ct1.publicInputs),
    crispVk: toBigints(result.crisp.vkFields),
    crispProof: toBigints(result.crisp.proofFields),
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

const toBigints = (fields: string[]): bigint[] => fields.map((field) => BigInt(field))

/** A 64-byte `r ‖ s` signature carries no recovery id, so try both parities. */
const isSignedBy = async (digest: Hex, compact: Hex, signer: Address): Promise<boolean> => {
  if (hexToBytes(compact).length !== 64) throw new Error('The attestation signature must be 64 bytes (r ‖ s)')
  for (const v of ['1b', '1c']) {
    const recovered = await recoverAddress({ hash: digest, signature: `${compact}${v}` })
    if (recovered.toLowerCase() === signer.toLowerCase()) return true
  }
  return false
}
