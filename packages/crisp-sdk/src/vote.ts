// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import {
  type Vote,
  type CensusVariant,
  type BallotBaseProofs,
  type BaseProof,
  type BaseProofs,
  type BaseVerificationKeys,
  type FoldVerifierTarget,
  type PrepareBallotInputs,
  type PreparedBallot,
  type ProofOptions,
  type ProofStage,
  ProofData,
} from './types'
import { proofToFields } from './utils'
import { checkVoteWeights, getZkInputsGenerator } from './encoding'
import { attachSignatureImpl, prepareCircuitInputsImpl } from './circuitInputs'
import { MASK_SIGNATURE, PROOF_STAGES } from './constants'
export { encodeVote, encryptVote, decodeTally, decryptVote, generateBFVKeys } from './encoding'
export { splitDigest } from './circuitInputs'
import { Noir, type CompiledCircuit } from '@noir-lang/noir_js'
import { Barretenberg, BackendType, Crs, GrumpkinCrs, UltraHonkBackend } from '@aztec-foundation/bb.js'
// Only the fold circuits are imported here. Their ABI is proof and verification-key shaped rather
// than polynomial shaped, so one artifact serves every preset and inlining them costs ~0.3MB.
// The BFV-shaped circuits arrive through `setCircuits()` — see ./circuits.
import foldCircuit from '../../../circuits/bin/fold/target/crisp_fold.json'
import foldOnchainCircuit from '../../../circuits/bin/fold_onchain/target/crisp_onchain_fold.json'
import { requireCircuits } from './circuits'

// The fold circuits are 2^21 gates (dyadic), so proving needs 2^21 points.
const SRS_SIZE = 2 ** 21
// The Grumpkin size `Barretenberg.new` loads.
const GRUMPKIN_SRS_SIZE = 2 ** 16

// Cached Barretenberg API instance — avoids re-initialising WASM + SRS on every proof.
let _bbApi: Barretenberg | null = null
let _bbApiInitPromise: Promise<Barretenberg> | null = null

/**
 * Load the SRS as `Barretenberg.new` does in the browser, without its IndexedDB cache of the
 * decompressed G1 points. That cache is one value of `SRS_SIZE * 64` bytes (128 MiB), above the
 * 127 MiB per-value limit of Chromium's IndexedDB, and bb.js does not catch the failed write, so
 * every proof would fail. The points still come through bb.js's `Crs`, which caches the G2 point.
 */
const initBrowserSrs = async (api: Barretenberg): Promise<void> => {
  const crs = await Crs.new(SRS_SIZE)
  const grumpkinCrs = await GrumpkinCrs.new(GRUMPKIN_SRS_SIZE)
  await api.srsInitSrs({ pointsBuf: crs.getG1Data(), numPoints: crs.numPoints, g2Point: crs.getG2Data() })
  await api.srsInitGrumpkinSrs({ pointsBuf: grumpkinCrs.getG1Data(), numPoints: grumpkinCrs.numPoints })
}

const getBBApi = async (): Promise<Barretenberg> => {
  if (_bbApi) return _bbApi
  if (_bbApiInitPromise) return _bbApiInitPromise

  _bbApiInitPromise = (async () => {
    try {
      let api: Barretenberg
      if (typeof window === 'undefined') {
        // Outside the browser, bb.js prefers its native Unix-socket backend, allows the bb
        // process only 5s to create the socket, and drops the timeout into an unhandled
        // rejection — callers then wait forever instead of failing. Pin Node to WASM.
        api = await Barretenberg.new({ srsSize: SRS_SIZE, backend: BackendType.Wasm })
      } else {
        // The browser selects the (multi-threaded) worker backend.
        api = await Barretenberg.new({ skipSrsInit: true })
        try {
          await initBrowserSrs(api)
        } catch (error) {
          // The instance never reaches `_bbApi`, so `destroyBBApi` could not free its workers.
          await api.destroy()
          throw error
        }
      }
      _bbApi = api
      return api
    } finally {
      _bbApiInitPromise = null
    }
  })()

  return _bbApiInitPromise
}

// Destroy the cached Barretenberg API and free its resources.
export const destroyBBApi = (): void => {
  _bbApiInitPromise = null
  if (_bbApi) {
    _bbApi.destroy()
    _bbApi = null
  }
}

/**
 * Encrypt a ballot and build every circuit input that does not depend on the signature.
 * Runs in a worker when available to avoid blocking the main thread.
 */
export const prepareCircuitInputs = async (inputs: PrepareBallotInputs): Promise<PreparedBallot> => {
  const preset = requireCircuits().preset

  if (typeof Worker !== 'undefined') {
    try {
      const worker = new Worker(new URL('./workers/generateCircuitInputs.worker.js', import.meta.url), { type: 'module' })
      return new Promise((resolve, reject) => {
        worker.onmessage = (e: MessageEvent<{ type: 'result'; prepared: PreparedBallot } | { type: 'error'; error: string }>) => {
          worker.terminate()
          if (e.data.type === 'result') {
            resolve(e.data.prepared)
          } else {
            reject(new Error(e.data.error))
          }
        }
        worker.onerror = (err) => {
          worker.terminate()
          reject(err)
        }
        worker.postMessage({ inputs, preset })
      })
    } catch {
      // Worker creation failed (e.g. bundler path resolution); fall back to main thread
    }
  }

  return prepareCircuitInputsImpl(inputs)
}

/**
 * Execute a circuit.
 * @param circuit - The circuit to execute.
 * @param inputs - The inputs to the circuit.
 * @returns The execute circuit result.
 */
export const executeCircuit = async (circuit: CompiledCircuit, inputs: any): Promise<{ witness: Uint8Array; returnValue: any }> => {
  const noir = new Noir(circuit as CompiledCircuit)

  return noir.execute(inputs)
}

type BallotCircuits = ReturnType<typeof requireCircuits>

/**
 * Execute the two base circuits of a ballot: `user_data_encryption` and the crisp ballot circuit. Witness
 * generation for both runs ahead of any proving; it is short and is counted as part of the first stage.
 */
const executeBaseCircuits = async (circuitInputs: any, censusMode: CensusVariant, circuits: BallotCircuits) => {
  const ballotCircuit = censusMode === 'onchain' ? circuits.crispOnchain : circuits.crisp
  // The circuit hard-codes the key's second component as the protocol CRS, so `pk1is` is not an input.
  const { witness: encryptionWitness } = await executeCircuit(circuits.userDataEncryption as CompiledCircuit, {
    pk0is: circuitInputs.pk0is,
    ct0is: circuitInputs.ct0is,
    ct1is: circuitInputs.ct1is,
    u: circuitInputs.u,
    e0: circuitInputs.e0,
    e1: circuitInputs.e1,
    k1: circuitInputs.k1,
    r: circuitInputs.r,
    r_ct1: circuitInputs.r_ct1,
  })
  // The two stacks share every input except how eligibility reaches the circuit: a census round
  // proves a Merkle path, an on-chain round takes the voting power the contract read.
  const eligibilityInputs =
    censusMode === 'onchain'
      ? { voting_power: circuitInputs.voting_power }
      : {
          merkle_root: circuitInputs.merkle_root,
          balance: circuitInputs.balance,
          merkle_proof_length: circuitInputs.merkle_proof_length,
          merkle_proof_indices: circuitInputs.merkle_proof_indices,
          merkle_proof_siblings: circuitInputs.merkle_proof_siblings,
        }

  const { witness: crispWitness, returnValue: crispReturnValue } = await executeCircuit(ballotCircuit as CompiledCircuit, {
    prev_ct0is: circuitInputs.prev_ct0is,
    prev_ct1is: circuitInputs.prev_ct1is,
    prev_ct_commitment: circuitInputs.prev_ct_commitment,
    sum_ct0is: circuitInputs.sum_ct0is,
    sum_ct1is: circuitInputs.sum_ct1is,
    sum_r0is: circuitInputs.sum_r0is,
    sum_r1is: circuitInputs.sum_r1is,
    ct0is: circuitInputs.ct0is,
    ct1is: circuitInputs.ct1is,
    k1: circuitInputs.k1,
    public_key_x: circuitInputs.public_key_x,
    public_key_y: circuitInputs.public_key_y,
    signature: circuitInputs.signature,
    digest_hi: circuitInputs.digest_hi,
    digest_lo: circuitInputs.digest_lo,
    slot_address: circuitInputs.slot_address,
    ...eligibilityInputs,
    is_first_vote: circuitInputs.is_first_vote,
    is_mask_vote: circuitInputs.is_mask_vote,
    num_options: circuitInputs.num_options,
  })

  return { ballotCircuit, encryptionWitness, crispWitness, crispReturnValue }
}

/**
 * Generate a proof for the CRISP circuit given the circuit inputs.
 * @param circuitInputs - Inputs used in both the CRISP and GRECO circuits.
 * @param censusMode - Which ballot and fold circuits to prove with.
 * @param options - `onProgress` is called as each of {@link PROOF_STAGES} starts.
 * @returns The proof.
 */
export const generateProof = async (
  circuitInputs: any,
  censusMode: CensusVariant = 'merkle',
  { onProgress, verifierTarget = 'evm' }: ProofOptions = {},
) => {
  const report = (stage: ProofStage) => onProgress?.({ stage, index: PROOF_STAGES.indexOf(stage), total: PROOF_STAGES.length })
  const api = await getBBApi()

  const circuits = requireCircuits()
  const foldCircuitForMode = censusMode === 'onchain' ? foldOnchainCircuit : foldCircuit

  report('encryption')
  const { ballotCircuit, encryptionWitness, crispWitness, crispReturnValue } = await executeBaseCircuits(
    circuitInputs,
    censusMode,
    circuits,
  )

  const userDataEncryptionBackend = new UltraHonkBackend((circuits.userDataEncryption as CompiledCircuit).bytecode, api)
  const crispBackend = new UltraHonkBackend((ballotCircuit as CompiledCircuit).bytecode, api)
  const foldBackend = new UltraHonkBackend((foldCircuitForMode as CompiledCircuit).bytecode, api)

  const { proof: userDataEncryptionProof, publicInputs: userDataEncryptionPublicInputs } = await userDataEncryptionBackend.generateProof(
    encryptionWitness,
    {
      verifierTarget: 'noir-recursive-no-zk',
    },
  )
  report('ballot')
  const { proof: crispProof, publicInputs: crispPublicInputs } = await crispBackend.generateProof(crispWitness, {
    verifierTarget: 'noir-recursive-no-zk',
  })

  // The recursive artifacts of the two inner proofs feed the fold.
  report('fold')
  const userDataEncryptionArtifacts = await userDataEncryptionBackend.generateRecursiveProofArtifacts(
    userDataEncryptionProof,
    userDataEncryptionPublicInputs.length,
    {
      verifierTarget: 'noir-recursive-no-zk',
    },
  )
  const crispArtifacts = await crispBackend.generateRecursiveProofArtifacts(crispProof, crispPublicInputs.length, {
    verifierTarget: 'noir-recursive-no-zk',
  })

  const { witness: foldWitness } = await executeCircuit(foldCircuitForMode as CompiledCircuit, {
    user_data_encryption_verification_key: userDataEncryptionArtifacts.vkAsFields,
    user_data_encryption_proof: proofToFields(userDataEncryptionProof),
    user_data_encryption_public_inputs: userDataEncryptionPublicInputs,
    user_data_encryption_key_hash: userDataEncryptionArtifacts.vkHash,
    crisp_verification_key: crispArtifacts.vkAsFields,
    crisp_proof: proofToFields(crispProof),
    crisp_key_hash: crispArtifacts.vkHash,
    prev_ct_commitment: circuitInputs.prev_ct_commitment,
    digest_hi: circuitInputs.digest_hi,
    digest_lo: circuitInputs.digest_lo,
    slot_address: circuitInputs.slot_address,
    // Position 4 of the public inputs, and the only slot the two stacks disagree on.
    ...(censusMode === 'onchain' ? { voting_power: circuitInputs.voting_power } : { merkle_root: circuitInputs.merkle_root }),
    is_first_vote: circuitInputs.is_first_vote,
    num_options: circuitInputs.num_options,
    final_ct_commitment: crispReturnValue[0].toString(),
    ct_commitment: crispReturnValue[1].toString(),
    k1_commitment: crispReturnValue[2].toString(),
  })

  if (verifierTarget === 'noir-recursive') {
    const recursive = await foldBackend.generateProof(foldWitness, { verifierTarget })
    const { vkAsFields, vkHash } = await foldBackend.generateRecursiveProofArtifacts(recursive.proof, recursive.publicInputs.length, {
      verifierTarget,
    })

    return { ...recursive, recursive: { proofFields: proofToFields(recursive.proof), vkFields: vkAsFields, vkHash } }
  }

  return foldBackend.generateProof(foldWitness, { verifierTarget })
}


/**
 * Prove the two base circuits of a ballot and stop: no fold.
 *
 * For a verifier that checks both proofs itself, as the Aztec `cast` does: it saves the 2^21-gate fold proof.
 * Every proof is a `noir-recursive-no-zk` proof, the flavour Aztec's `verify_honk_proof_non_zk` checks in a
 * private function. Skipping zero-knowledge is safe there because the proofs are private inputs of the function
 * and never leave the voter's device; the transaction proof hides them. A verifier that publishes the proofs
 * needs the fold ({@link generateProof}) instead.
 *
 * @param circuitInputs - The inputs of {@link prepareBallot}, with the signature attached.
 * @param censusMode - Which ballot circuit to prove with.
 * @param options - `onProgress` is called as each of the two stages starts (`total` is 2).
 */
export const generateBaseProofs = async (
  circuitInputs: any,
  censusMode: CensusVariant = 'merkle',
  { onProgress }: Pick<ProofOptions, 'onProgress'> = {},
): Promise<BaseProofs> => {
  const stages: ProofStage[] = ['encryption', 'ballot']
  const report = (stage: ProofStage) => onProgress?.({ stage, index: stages.indexOf(stage), total: stages.length })
  const api = await getBBApi()
  const circuits = requireCircuits()

  report('encryption')
  const { ballotCircuit, encryptionWitness, crispWitness } = await executeBaseCircuits(circuitInputs, censusMode, circuits)

  const prove = async (circuit: unknown, witness: Uint8Array): Promise<BaseProof> => {
    const backend = new UltraHonkBackend((circuit as CompiledCircuit).bytecode, api)
    const { proof, publicInputs } = await backend.generateProof(witness, { verifierTarget: 'noir-recursive-no-zk' })
    const { vkAsFields, vkHash } = await backend.generateRecursiveProofArtifacts(proof, publicInputs.length, {
      verifierTarget: 'noir-recursive-no-zk',
    })

    return { proof, proofFields: proofToFields(proof), vkFields: vkAsFields, vkHash, publicInputs }
  }

  const encryption = await prove(circuits.userDataEncryption, encryptionWitness)
  report('ballot')
  const crisp = await prove(ballotCircuit, crispWitness)

  return { encryption, crisp }
}

/**
 * Validate a vote.
 * @param vote - The vote to validate.
 * @param balance - The balance of the voter.
 */
export const validateVote = (vote: Vote, balance: bigint): void => {
  const numChoices = vote.length

  checkVoteWeights(vote, getZkInputsGenerator().getBFVParams().plaintextModulus)

  if (numChoices === 2) {
    // Binary: mutually exclusive
    const nonZeroCount = vote.filter((v) => v > 0).length
    if (nonZeroCount > 1) {
      throw new Error('Invalid vote: for 2 options, only one choice can be non-zero')
    }
    const votedAmount = vote.find((v) => v > 0) ?? 0
    if (votedAmount > balance) {
      throw new Error('Invalid vote: vote exceeds balance')
    }
  } else {
    // 3+ options: split allowed, total capped
    const total = vote.reduce((sum, v) => sum + v, 0)
    if (total > balance) {
      throw new Error(`Invalid vote: total votes (${total}) exceed balance (${balance})`)
    }
  }
}

/**
 * Phase one: encrypt a ballot, before the voter signs anything.
 *
 * A ballot must be encrypted before it can be signed, because the digest binds the ciphertext.
 * Take `ctCommitment` from the result, read the digest from `CRISPProgram.ballotDigest`, have the
 * voter sign it, then call {@link finishBallotProof}.
 *
 * @param inputs - The ballot to encrypt.
 * @returns The prepared ballot.
 */
export const prepareBallot = async (inputs: PrepareBallotInputs): Promise<PreparedBallot> => {
  if (!inputs.isMaskVote) {
    validateVote(inputs.vote, inputs.censusMode === 'onchain' ? inputs.votingPower : inputs.balance)
  }

  // Through the worker wrapper, not the impl: BFV encryption is the heaviest step in the flow and
  // running it on the main thread freezes the browser for its duration. The wrapper falls back to
  // the main thread by itself where `Worker` is unavailable.
  return prepareCircuitInputs(inputs)
}

/**
 * Phase two: prove a prepared ballot, given the signature over its digest.
 *
 * Get the digest from `CRISPProgram.ballotDigest(e3Id, slot, prepared.ctCommitment)` and have the
 * voter sign it. Reading it from the contract rather than rebuilding the EIP-712 struct here means
 * there is only one implementation of the domain to keep correct.
 *
 * @param prepared The output of `prepareBallot`.
 * @param digest The ballot digest.
 * @param signature The voter signature over that digest.
 * @param options `onProgress` reports each proof stage as it starts.
 * @returns The proof.
 */
export const finishBallotProof = async (
  prepared: PreparedBallot,
  digest: `0x${string}`,
  signature: `0x${string}`,
  options: ProofOptions = {},
): Promise<ProofData> => {
  const circuitInputs = await attachSignatureImpl(prepared, digest, signature)

  return {
    ...(await generateProof(circuitInputs, prepared.censusMode, options)),
    encryptedVote: prepared.encryptedVote,
    parentIndexPlusOne: prepared.parentIndexPlusOne,
  }
}

/**
 * Phase two for a mask.
 *
 * A mask carries the same digest as a real vote, because `CRISPProgram.publishInput` computes it
 * for every input regardless of branch. Only the signature is a placeholder, and the circuit does
 * not check it on the mask branch. Passing a real digest here is what keeps a mask and a vote
 * indistinguishable in the published public inputs.
 *
 * @param prepared The output of `prepareBallot` with `isMaskVote: true`.
 * @param digest The ballot digest, from the same contract call a real vote would use.
 * @param options `onProgress` reports each proof stage as it starts.
 * @returns The proof.
 */
export const finishMaskProof = async (prepared: PreparedBallot, digest: `0x${string}`, options: ProofOptions = {}): Promise<ProofData> => {
  return finishBallotProof(prepared, digest, MASK_SIGNATURE, options)
}

/**
 * Phase two without the fold: the two base proofs of a prepared ballot, for a verifier that checks them
 * itself (see {@link generateBaseProofs}). {@link finishBallotProof} stays the way to get the fold L1 verifies.
 *
 * @param prepared The output of `prepareBallot`.
 * @param digest The ballot digest.
 * @param signature The voter signature over that digest.
 * @param options `onProgress` reports each of the three proof stages as it starts.
 */
export const finishBallotBaseProofs = async (
  prepared: PreparedBallot,
  digest: `0x${string}`,
  signature: `0x${string}`,
  options: Pick<ProofOptions, 'onProgress'> = {},
): Promise<BallotBaseProofs> => {
  const circuitInputs = await attachSignatureImpl(prepared, digest, signature)

  return {
    ...(await generateBaseProofs(circuitInputs, prepared.censusMode, options)),
    encryptedVote: prepared.encryptedVote,
    parentIndexPlusOne: prepared.parentIndexPlusOne,
  }
}

/** {@link finishBallotBaseProofs} for a mask, which carries the same digest and a placeholder signature. */
export const finishMaskBaseProofs = async (
  prepared: PreparedBallot,
  digest: `0x${string}`,
  options: Pick<ProofOptions, 'onProgress'> = {},
): Promise<BallotBaseProofs> => finishBallotBaseProofs(prepared, digest, MASK_SIGNATURE, options)

/**
 * Locally verify a Noir proof.
 * @param proof - The proof to verify.
 * @returns True if the proof is valid, false otherwise.
 */
export const verifyProof = async (
  proof: ProofData,
  censusMode: CensusVariant = 'merkle',
  verifierTarget: FoldVerifierTarget = 'evm',
): Promise<boolean> => {
  const api = await getBBApi()
  const circuit = censusMode === 'onchain' ? foldOnchainCircuit : foldCircuit
  const foldBackend = new UltraHonkBackend(circuit.bytecode, api)

  return foldBackend.verifyProof(proof, { verifierTarget })
}

/**
 * The verification key of the fold circuit for the `noir-recursive` target, which a contract that
 * verifies the fold proof in-circuit pins by `vkHash`.
 *
 * The fold circuit holds no preset-bound data (its constants cover both presets), so the key does
 * not depend on the registered preset.
 */
export const getFoldRecursiveVerificationKey = async (
  censusMode: CensusVariant = 'merkle',
): Promise<{ vkFields: string[]; vkHash: string }> => {
  const api = await getBBApi()
  const circuit = censusMode === 'onchain' ? foldOnchainCircuit : foldCircuit
  const { vkAsFields, vkHash } = await new UltraHonkBackend(circuit.bytecode, api).generateRecursiveProofArtifacts(new Uint8Array(), 0, {
    verifierTarget: 'noir-recursive',
  })

  return { vkFields: vkAsFields, vkHash }
}

/**
 * The verification keys of the two base circuits of the registered preset for the `noir-recursive-no-zk` target,
 * which a contract that verifies the base proofs in-circuit pins by `vkHash`. Unlike the fold's, they depend on the
 * preset: register it first (`setCircuits`).
 */
export const getBaseVerificationKeys = async (censusMode: CensusVariant = 'merkle'): Promise<BaseVerificationKeys> => {
  const api = await getBBApi()
  const circuits = requireCircuits()
  const keyOf = async (circuit: unknown) => {
    const { vkAsFields, vkHash } = await new UltraHonkBackend((circuit as CompiledCircuit).bytecode, api).generateRecursiveProofArtifacts(
      new Uint8Array(),
      0,
      { verifierTarget: 'noir-recursive-no-zk' },
    )

    return { vkFields: vkAsFields, vkHash }
  }

  return {
    encryption: await keyOf(circuits.userDataEncryption),
    crisp: await keyOf(censusMode === 'onchain' ? circuits.crispOnchain : circuits.crisp),
  }
}

/** Locally verify the two base proofs, each against its own circuit. */
export const verifyBaseProofs = async (proofs: BaseProofs, censusMode: CensusVariant = 'merkle'): Promise<boolean> => {
  const api = await getBBApi()
  const circuits = requireCircuits()
  const check = async (circuit: unknown, { proof, publicInputs }: BaseProof) =>
    new UltraHonkBackend((circuit as CompiledCircuit).bytecode, api).verifyProof({ proof, publicInputs }, { verifierTarget: 'noir-recursive-no-zk' })

  return (
    (await check(circuits.userDataEncryption, proofs.encryption)) &&
    (await check(censusMode === 'onchain' ? circuits.crispOnchain : circuits.crisp, proofs.crisp))
  )
}
