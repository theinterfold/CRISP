// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { poseidon2Hash } from '@aztec-labs/foundation/crypto/poseidon'
import { MERKLE_TREE_MAX_DEPTH } from '@crisp-e3/sdk'
import { Noir, type CompiledCircuit } from '@noir-lang/noir_js'
import { poseidon2, poseidon3 } from 'poseidon-lite'
import { bytesToHex, hashTypedData, hexToBytes, recoverPublicKey, toHex, type Address, type Hex } from 'viem'
import { publicKeyToAddress } from 'viem/utils'

import stagingPassVotesCircuit from '../../../core/circuits/staging_pass_votes/compiled/staging_pass_votes.json'
import { crispDomain, type TypedDataSigner } from './ballot'
import type { Census } from './census'
import { roundIdOf } from './messages'
import type { InputAttestation } from './server'
import { halves, stagingProver, stagingRequestDigest, type StagingPass, type StagingRequest } from './staging-pass'

const circuit = stagingPassVotesCircuit as unknown as CompiledCircuit

const prover = stagingProver(circuit.bytecode)

/** The EIP-712 `StagingKey(uint256 e3Id)` in the CRISP domain: signed once per slot and round to derive the staging secret. */
const stagingKeyTypedData = (e3Id: bigint, l1ChainId: bigint | number, program: Address) =>
  ({
    domain: crispDomain(l1ChainId, program),
    types: { StagingKey: [{ name: 'e3Id', type: 'uint256' }] },
    primaryType: 'StagingKey',
    message: { e3Id },
  }) as const

/** A big-endian 32-byte value as two 128-bit limbs `(high, low)`. */
const limbs = (bytes: Uint8Array): [bigint, bigint] => [BigInt(bytesToHex(bytes.slice(0, 16))), BigInt(bytesToHex(bytes.slice(16, 32)))]

/**
 * The per-round staging secret a `StagingKey` signature derives, exactly as `bind_staging_key` does: Poseidon2 (Aztec's sponge) of
 * the signature's `r` and `s` as four 128-bit limbs `[r_hi, r_lo, s_hi, s_lo]`. A deterministic signer re-derives it from the
 * same signature; keep the secret, never send it anywhere.
 */
export const stagingSecret = async (signature: Hex): Promise<bigint> => {
  const bytes = hexToBytes(signature)
  const [rHi, rLo] = limbs(bytes.slice(0, 32))
  const [sHi, sLo] = limbs(bytes.slice(32, 64))

  return (await poseidon2Hash([rHi, rLo, sHi, sLo])).toBigInt()
}

/** `hash_2([secret, round_id])` (circom Poseidon): the leaf `bind_staging_key` inserts into the staging tree. */
export const stagingCommitment = (secret: bigint, roundId: bigint): bigint => poseidon2([secret, roundId])

/** `hash_3([secret, round_id, k])` (circom Poseidon): the rate-limit tag of the `k`-th pass of a secret. */
export const votesStagingTag = (secret: bigint, roundId: bigint, counter: number): bigint => poseidon3([secret, roundId, BigInt(counter)])

/**
 * Sign `StagingKey` with `signer`, recover the slot's public key from the signature, check it is `slot`'s, and derive what
 * `bind_staging_key` takes: the public key halves, the 64-byte `r ‖ s`, and the secret and its commitment.
 */
export const stagingKeyBinding = async (args: {
  signer: TypedDataSigner
  e3Id: bigint
  l1ChainId: bigint | number
  program: Address
  slot: Address
}) => {
  const typedData = stagingKeyTypedData(args.e3Id, args.l1ChainId, args.program)
  const signature = await args.signer(typedData)
  const publicKey = hexToBytes(await recoverPublicKey({ hash: hashTypedData(typedData), signature }))
  if (publicKeyToAddress(bytesToHex(publicKey)).toLowerCase() !== args.slot.toLowerCase()) {
    throw new Error(`The staging-key signature was not made by slot ${args.slot}`)
  }
  const secret = await stagingSecret(signature)

  return {
    secret,
    commitment: stagingCommitment(secret, roundIdOf(args.e3Id)),
    publicKeyX: publicKey.slice(1, 33),
    publicKeyY: publicKey.slice(33, 65),
    signature: hexToBytes(signature).slice(0, 64),
  }
}

/** Free the votes staging prover's Barretenberg instance. */
export const destroyVotesStagingPassProver = prover.destroy

export type BuildVotesStagingPassInputs = {
  /** The slot's staging secret and the round's staging tree (`CrispAztecVotes.stagingKey`): the voter's OWN, for a vote and a mask alike. */
  secret: bigint
  stagingTree: Census
  request: StagingRequest
  /** The server's `staging_max_requests`. */
  maxRequests: number
  /** Which pass of this secret in this round, `0 <= counter < maxRequests`; spent by every staging, refused or not. */
  counter: number
}

/**
 * Prove a votes staging pass (`extensions/core/circuits/staging_pass_votes`): "my staging commitment is in this round's staging
 * tree, and this is its k-th pass", revealing only the tag `hash_3([secret, round_id, k])`. The request digest is the
 * existing raw `stagingRequestDigest`, a public input that binds the proof to the request.
 */
export const buildVotesStagingPass = async (inputs: BuildVotesStagingPassInputs): Promise<StagingPass> => {
  const { request, maxRequests, counter, stagingTree, secret } = inputs
  const roundId = roundIdOf(request.e3Id)
  const index = stagingTree.leaves.indexOf(stagingCommitment(secret, roundId))
  if (index === -1) throw new Error('The slot has not bound a staging key in this round (or the staging tree is stale)')
  const proof = stagingTree.tree.generateProof(index)

  const depth = proof.siblings.length
  const siblings = [...proof.siblings, ...Array(MERKLE_TREE_MAX_DEPTH - depth).fill(0n)]
  const indices = Array.from({ length: MERKLE_TREE_MAX_DEPTH }, (_, i) => ((BigInt(proof.index) >> BigInt(i)) & 1n) === 1n)
  const [digestHi, digestLo] = halves(stagingRequestDigest(request))

  const field = (value: bigint) => toHex(value)
  const { honk } = await prover.get()
  const { witness } = await new Noir(circuit).execute({
    secret: field(secret),
    merkle_proof_length: depth,
    merkle_proof_indices: indices,
    merkle_proof_siblings: siblings.map(field),
    k: counter,
    staging_root: field(stagingTree.root),
    round_id: field(roundId),
    request_digest_hi: field(digestHi),
    request_digest_lo: field(digestLo),
    max_requests: maxRequests,
    tag: field(votesStagingTag(secret, roundId, counter)),
  })
  const { proof: bytes, publicInputs } = await honk.generateProof(witness, { verifierTarget: 'evm' })

  return { proof: bytesToHex(bytes), publicInputs: publicInputs as Hex[] }
}

// The CRISP server's refusals (`staging_pass.rs`) that another attempt gets past.
const TAG_USED = 'The staging pass was already used'
const UNKNOWN_ROOT = 'The staging pass names a census root this round has not had'
/** How long, and how often, a pass whose root the server has not read yet is sent again, counted from its first refusal. The server reads new roots at most every 5 s. */
const ROOT_WAIT_MS = 3 * 60_000
const ROOT_RETRY_MS = 5_000

/**
 * Stage with the first unused pass of a staging key, from `counter` up, and report the counter that staged. The server keeps the
 * tag of every pass it took: a used one costs a new pass with the next counter, not a new ballot. It checks the root before it takes
 * the tag, so a pass whose root it has not read from Aztec yet (a staging key bound a moment ago) is sent again unchanged.
 */
export const stageWithNextPass = async (args: {
  counter: number
  maxRequests: number
  prove: (counter: number) => Promise<StagingPass>
  stage: (pass: StagingPass) => Promise<InputAttestation>
  onWait?: () => void
}): Promise<{ attestation: InputAttestation; counter: number }> => {
  for (let counter = args.counter; counter < args.maxRequests; counter++) {
    const pass = await args.prove(counter)
    let deadline: number | undefined
    for (;;) {
      try {
        return { attestation: await args.stage(pass), counter }
      } catch (error) {
        const refusal = error instanceof Error ? error.message : ''
        if (refusal.includes(TAG_USED)) break
        if (!refusal.includes(UNKNOWN_ROOT)) throw error
        deadline ??= Date.now() + ROOT_WAIT_MS
        if (Date.now() >= deadline) throw error
        args.onWait?.()
        await new Promise((resolve) => setTimeout(resolve, ROOT_RETRY_MS))
      }
    }
  }
  throw new Error(`This staging key has used all ${args.maxRequests} passes the CRISP server accepts from it in a round`)
}

/** Where a client keeps what it must not lose between sessions (a caller-supplied `localStorage` wrapper, a file, …). */
export type SecretStorage = {
  get: (key: string) => Promise<string | null | undefined> | string | null | undefined
  set: (key: string, value: string) => Promise<void> | void
}
