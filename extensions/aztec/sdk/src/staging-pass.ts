// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { BackendType, Barretenberg, UltraHonkBackend } from '@aztec-foundation/bb.js'
import { generateMerkleProof, hashLeaf } from '@crisp-e3/sdk'
import { Noir, type CompiledCircuit } from '@noir-lang/noir_js'
import { poseidon6 } from 'poseidon-lite'
import { bytesToHex, encodeAbiParameters, hexToBytes, keccak256, recoverPublicKey, toHex, type Address, type Hex } from 'viem'
import { publicKeyToAddress } from 'viem/utils'

import stagingPassCircuit from '../../../core/circuits/staging_pass/compiled/staging_pass.json'
import type { DigestSigner } from './cast'
import type { Census } from './census'
import { roundIdOf } from './messages'

// `build.sh` strips the debug symbols a `CompiledCircuit` is typed to carry; proving needs neither.
const circuit = stagingPassCircuit as unknown as CompiledCircuit

/**
 * The staging pass: an anonymous, rate-limited ticket for `POST /voting/remote-input`.
 *
 * The CRISP server attests availability of a ciphertext before the `cast`, so anyone could fill its storage with bytes that
 * are never cast. A pass proves, in zero knowledge, "I hold the key of SOME slot registered in this round's census" and
 * reveals a one-time tag `Poseidon(x, y, roundId, k)` of that key, `k < maxRequests`. The server refuses a repeated tag, so a
 * slot stages at most `maxRequests` ciphertexts a round, and it cannot tell which slot or whether the ciphertext is a vote or
 * a mask: a mask is staged with the MASKER's own slot key while the request names the masked slot.
 *
 * Unlinkability holds as long as the slot public key stays unpublished: the registration binds only the address, and a
 * ballot's signature is a private input of its proof. A slot owner who shows a signature made with the key can be linked to
 * its tags.
 *
 * The circuit is `extensions/core/circuits/staging_pass`. Proofs use bb's default target (`evm`: keccak transcript, zero
 * knowledge), which is what the server's `bb verify` takes.
 */
export type StagingPass = {
  /** The proof, `0x` hex. */
  proof: Hex
  /** `census_root, round_id, request_digest_hi, request_digest_lo, max_requests, tag`, each a 32-byte hex field. */
  publicInputs: Hex[]
}

/** The staging request a pass is bound to; every request has this shape, whether it carries a vote or a mask. */
export type StagingRequest = {
  l1ChainId: bigint | number
  /** The CRISP program on L1. */
  program: Address
  e3Id: bigint
  ciphertextCommitment: Hex
  /** The slot the ciphertext is published to: the voter's own for a vote, the masked one for a mask. */
  slot: Address
  parentIndexPlusOne: number
}

const STAGING_DOMAIN = 'CRISP_STAGING_V1'

/**
 * What the pass signs and exposes as `request_digest`: `keccak256(abi.encode("CRISP_STAGING_V1", chainId, program, e3Id,
 * ciphertextCommitment, slot, parentIndexPlusOne))`. The server recomputes it from the request, so a pass cannot be replayed
 * for other bytes, another slot or another round.
 */
export const stagingRequestDigest = (request: StagingRequest): Hex =>
  keccak256(
    encodeAbiParameters(
      [
        { type: 'string' },
        { type: 'uint256' },
        { type: 'address' },
        { type: 'uint256' },
        { type: 'bytes32' },
        { type: 'address' },
        { type: 'uint40' },
      ],
      [
        STAGING_DOMAIN,
        BigInt(request.l1ChainId),
        request.program,
        request.e3Id,
        request.ciphertextCommitment,
        request.slot,
        request.parentIndexPlusOne,
      ],
    ),
  )

/** The two 128-bit halves of a 32-byte digest, as the circuit's public inputs. */
const halves = (digest: Hex): [bigint, bigint] => [BigInt(`0x${digest.slice(2, 34)}`), BigInt(`0x${digest.slice(34)}`)]

/** `Poseidon(x_hi, x_lo, y_hi, y_lo, roundId, k)`: the tag of the `k`-th pass of a slot key in a round. */
export const stagingTag = (publicKeyX: Uint8Array, publicKeyY: Uint8Array, roundId: bigint, counter: number): bigint => {
  const [xHi, xLo] = halves(bytesToHex(publicKeyX, { size: 32 }))
  const [yHi, yLo] = halves(bytesToHex(publicKeyY, { size: 32 }))

  return poseidon6([xHi, xLo, yHi, yLo, roundId, BigInt(counter)])
}

// The circuit has 2^17 dyadic gates.
const SRS_SIZE = 2 ** 17

let backend: Promise<{ api: Barretenberg; honk: UltraHonkBackend }> | undefined

const getBackend = () => {
  backend ??= (async () => {
    // Outside the browser bb.js prefers a native socket backend and hangs when it cannot start; pin Node to WASM.
    const api =
      typeof window === 'undefined'
        ? await Barretenberg.new({ srsSize: SRS_SIZE, backend: BackendType.Wasm })
        : await Barretenberg.new({ srsSize: SRS_SIZE })

    return { api, honk: new UltraHonkBackend(circuit.bytecode, api) }
  })()

  return backend
}

/** Free the prover's Barretenberg instance (WASM threads keep a Node process alive). A later pass creates a new one. */
export const destroyStagingPassProver = async (): Promise<void> => {
  const pending = backend
  backend = undefined
  if (pending) await (await pending).api.destroy()
}

export type BuildStagingPassInputs = {
  /** Signs the request digest with the key of a slot registered in the census: the voter's OWN slot, for a vote and a mask alike. */
  signer: DigestSigner
  census: Census
  /** Credits every census member holds in this round (the census leaf is `Poseidon(slot, credits)`). */
  credits: bigint
  request: StagingRequest
  /** The server's `staging_max_requests` (`GET /voting/remote-input/config`). */
  maxRequests: number
  /**
   * Which pass of this slot key in this round, `0 <= counter < maxRequests`. The server accepts each (key, round, counter) once,
   * so keep a counter per key and round on the client and use the next one for every staging, vote or mask; a refused or lost
   * staging still consumed its counter.
   */
  counter: number
}

/** Prove a staging pass for `inputs.request` (about 80k gates: a few seconds in Node). */
export const buildStagingPass = async (inputs: BuildStagingPassInputs): Promise<StagingPass> => {
  const { request, maxRequests, counter, census } = inputs
  if (!Number.isInteger(counter) || counter < 0 || counter >= maxRequests) {
    throw new Error(`The staging counter ${counter} is outside [0, ${maxRequests})`)
  }

  const digest = stagingRequestDigest(request)
  const signature = await inputs.signer(digest)
  const signatureBytes = hexToBytes(signature)
  if (signatureBytes.length !== 65) throw new Error('The staging signature must be 65 bytes (r ‖ s ‖ v)')
  const publicKey = hexToBytes(await recoverPublicKey({ hash: digest, signature }))
  const publicKeyX = publicKey.slice(1, 33)
  const publicKeyY = publicKey.slice(33, 65)

  const member = publicKeyToAddress(bytesToHex(publicKey))
  if (!census.leaves.includes(hashLeaf(member, inputs.credits))) {
    throw new Error(`The staging key's slot ${member} is not registered in the census, so it cannot stage`)
  }
  const merkle = generateMerkleProof(inputs.credits, member, census.leaves)
  if (merkle.proof.root !== census.root) throw new Error('The census leaves do not rebuild the census root')

  const roundId = roundIdOf(request.e3Id)
  const tag = stagingTag(publicKeyX, publicKeyY, roundId, counter)
  const [digestHi, digestLo] = halves(digest)

  const field = (value: bigint) => toHex(value)
  const { honk } = await getBackend()
  const noir = new Noir(circuit)
  const { witness } = await noir.execute({
    public_key_x: Array.from(publicKeyX),
    public_key_y: Array.from(publicKeyY),
    signature: Array.from(signatureBytes.slice(0, 64)),
    credits: field(inputs.credits),
    merkle_proof_length: merkle.length,
    merkle_proof_indices: merkle.indices.map((index) => index === 1),
    merkle_proof_siblings: merkle.proof.siblings.map(field),
    k: counter,
    census_root: field(census.root),
    round_id: field(roundId),
    request_digest_hi: field(digestHi),
    request_digest_lo: field(digestLo),
    max_requests: maxRequests,
    tag: field(tag),
  })
  const { proof, publicInputs } = await honk.generateProof(witness, { verifierTarget: 'evm' })

  return { proof: bytesToHex(proof), publicInputs: publicInputs as Hex[] }
}
