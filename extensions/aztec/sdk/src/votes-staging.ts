// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { BackendType, Barretenberg, UltraHonkBackend } from '@aztec-foundation/bb.js'
import { poseidon2Hash } from '@aztec-labs/foundation/crypto/poseidon'
import { Noir, type CompiledCircuit } from '@noir-lang/noir_js'
import { poseidon2, poseidon3 } from 'poseidon-lite'
import { bytesToHex, hashTypedData, hexToBytes, recoverPublicKey, toHex, type Address, type Hex } from 'viem'
import { publicKeyToAddress } from 'viem/utils'

import stagingPassVotesCircuit from '../../../core/circuits/staging_pass_votes/compiled/staging_pass_votes.json'
import { crispDomain, type TypedDataSigner } from './ballot'
import type { Census } from './census'
import { roundIdOf } from './messages'
import type { StagingPass, StagingRequest } from './staging-pass'
import { stagingRequestDigest } from './staging-pass'

const circuit = stagingPassVotesCircuit as unknown as CompiledCircuit

const MERKLE_TREE_MAX_DEPTH = 20

const STAGING_KEY_TYPES = { StagingKey: [{ name: 'e3Id', type: 'uint256' }] } as const

/** The EIP-712 `StagingKey(uint256 e3Id)` in the CRISP domain: signed once per slot and round to derive the staging secret. */
export const stagingKeyTypedData = (e3Id: bigint, l1ChainId: bigint | number, program: Address) =>
  ({
    domain: crispDomain(l1ChainId, program),
    types: STAGING_KEY_TYPES,
    primaryType: 'StagingKey',
    message: { e3Id },
  }) as const

export const stagingKeyDigest = (e3Id: bigint, l1ChainId: bigint | number, program: Address): Hex =>
  hashTypedData(stagingKeyTypedData(e3Id, l1ChainId, program))

/** A big-endian 32-byte value as two 128-bit limbs `(high, low)`. */
const limbs = (bytes: Uint8Array): [bigint, bigint] => [BigInt(bytesToHex(bytes.slice(0, 16))), BigInt(bytesToHex(bytes.slice(16, 32)))]

/**
 * The per-round staging secret a `StagingKey` signature derives, exactly as `bind_staging_key` does: Poseidon2 (Aztec's sponge) of
 * the signature's `r` and `s` as four 128-bit limbs `[r_hi, r_lo, s_hi, s_lo]`. A deterministic signer re-derives it from the
 * same signature; keep the secret, never send it anywhere.
 */
export const stagingSecret = async (signature: Hex): Promise<bigint> => {
  const bytes = hexToBytes(signature)
  if (bytes.length !== 64 && bytes.length !== 65) throw new Error('The staging-key signature must be 64 or 65 bytes (r ‖ s [‖ v])')
  const [rHi, rLo] = limbs(bytes.slice(0, 32))
  const [sHi, sLo] = limbs(bytes.slice(32, 64))

  return (await poseidon2Hash([rHi, rLo, sHi, sLo])).toBigInt()
}

/** `hash_2([secret, round_id])` (circom Poseidon): the leaf `bind_staging_key` inserts into the staging tree. */
export const stagingCommitment = (secret: bigint, roundId: bigint): bigint => poseidon2([secret, roundId])

/** `hash_3([secret, round_id, k])` (circom Poseidon): the rate-limit tag of the `k`-th pass of a secret. */
export const votesStagingTag = (secret: bigint, roundId: bigint, counter: number): bigint => poseidon3([secret, roundId, BigInt(counter)])

/** What `bind_staging_key` takes, derived from a signed `StagingKey`. */
export type StagingKeyBinding = {
  secret: bigint
  commitment: bigint
  publicKeyX: Uint8Array
  publicKeyY: Uint8Array
  /** 64-byte `r ‖ s`. */
  signature: Uint8Array
}

/** Sign `StagingKey` with `signer`, recover the slot's public key from the signature and check it is `slot`'s. */
export const stagingKeyBinding = async (args: {
  signer: TypedDataSigner
  e3Id: bigint
  l1ChainId: bigint | number
  program: Address
  slot: Address
}): Promise<StagingKeyBinding> => {
  const signature = await args.signer(stagingKeyTypedData(args.e3Id, args.l1ChainId, args.program))
  const bytes = hexToBytes(signature)
  if (bytes.length !== 65) throw new Error('The staging-key signature must be 65 bytes (r ‖ s ‖ v)')
  const publicKey = hexToBytes(await recoverPublicKey({ hash: stagingKeyDigest(args.e3Id, args.l1ChainId, args.program), signature }))
  if (publicKeyToAddress(bytesToHex(publicKey)).toLowerCase() !== args.slot.toLowerCase()) {
    throw new Error(`The staging-key signature was not made by slot ${args.slot}`)
  }
  const secret = await stagingSecret(signature)

  return {
    secret,
    commitment: stagingCommitment(secret, roundIdOf(args.e3Id)),
    publicKeyX: publicKey.slice(1, 33),
    publicKeyY: publicKey.slice(33, 65),
    signature: bytes.slice(0, 64),
  }
}

const halves = (digest: Hex): [bigint, bigint] => [BigInt(`0x${digest.slice(2, 34)}`), BigInt(`0x${digest.slice(34)}`)]

// The circuit has well under 2^17 gates.
const SRS_SIZE = 2 ** 17

let backend: Promise<{ api: Barretenberg; honk: UltraHonkBackend }> | undefined

const getBackend = () => {
  backend ??= (async () => {
    const api =
      typeof window === 'undefined'
        ? await Barretenberg.new({ srsSize: SRS_SIZE, backend: BackendType.Wasm })
        : await Barretenberg.new({ srsSize: SRS_SIZE })

    return { api, honk: new UltraHonkBackend(circuit.bytecode, api) }
  })()

  return backend
}

/** Free the votes staging prover's Barretenberg instance (WASM threads keep a Node process alive). */
export const destroyVotesStagingPassProver = async (): Promise<void> => {
  const pending = backend
  backend = undefined
  if (pending) await (await pending).api.destroy()
}

export type BuildVotesStagingPassInputs = {
  /** The slot's staging secret (`bindStagingKey`): the voter's OWN, for a vote and a mask alike. */
  secret: bigint
  /** The round's staging tree (`CrispAztecVotes.getStagingTree`); must hold the secret's commitment. */
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
  if (!Number.isInteger(counter) || counter < 0 || counter >= maxRequests) {
    throw new Error(`The staging counter ${counter} is outside [0, ${maxRequests})`)
  }
  const roundId = roundIdOf(request.e3Id)
  const index = stagingTree.leaves.indexOf(stagingCommitment(secret, roundId))
  if (index === -1) throw new Error('The slot has not bound a staging key in this round (or the staging tree is stale)')
  const proof = stagingTree.tree.generateProof(index)
  if (proof.root !== stagingTree.root) throw new Error('The staging leaves do not rebuild the staging root')

  const depth = proof.siblings.length
  const siblings = [...proof.siblings, ...Array(MERKLE_TREE_MAX_DEPTH - depth).fill(0n)]
  const indices = Array.from({ length: MERKLE_TREE_MAX_DEPTH }, (_, i) => i < depth && ((BigInt(proof.index) >> BigInt(i)) & 1n) === 1n)
  const [digestHi, digestLo] = halves(stagingRequestDigest(request))

  const field = (value: bigint) => toHex(value)
  const { honk } = await getBackend()
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

/** Where a client keeps a slot's staging secret between sessions (a caller-supplied `localStorage` wrapper, a file, …). */
export type SecretStorage = {
  get: (key: string) => Promise<string | null | undefined> | string | null | undefined
  set: (key: string, value: string) => Promise<void> | void
}

/**
 * Persist and restore staging secrets per `(program, e3Id, slot)`. The secret derives from a signature, so a deterministic signer
 * needs no store; a signer that signs differently each time (or a lost bind beyond the cap) does.
 */
export const stagingSecretStore = (storage: SecretStorage) => {
  const key = (program: Address, e3Id: bigint, slot: Address) =>
    `crisp-aztec-votes:staging-secret:${program.toLowerCase()}:${e3Id}:${slot.toLowerCase()}`

  return {
    async get(program: Address, e3Id: bigint, slot: Address): Promise<bigint | undefined> {
      const value = await storage.get(key(program, e3Id, slot))

      return value ? BigInt(value) : undefined
    },
    async set(program: Address, e3Id: bigint, slot: Address, secret: bigint): Promise<void> {
      await storage.set(key(program, e3Id, slot), toHex(secret))
    },
  }
}
