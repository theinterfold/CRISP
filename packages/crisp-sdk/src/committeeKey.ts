// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { ZKInputsGenerator } from '@crisp-e3/zk-inputs'
import { bytesToHex, isHex, size } from 'viem'

import { getPublicClient } from './chain'
import { blockAtTimestamp } from './logs'
import { MAX_COMMITTEE_KEY_CANDIDATES, getCommitteePublicKeyCandidates, getRoundBfvParams, getRoundState } from './round'

import type { RoundBfvParams, RoundReadOptions } from './round'

const generators = new Map<string, InstanceType<typeof ZKInputsGenerator>>()

/**
 * A generator for the round's own BFV parameters, cached by parameter identity so a spammed round
 * does not rebuild the parameters for every candidate.
 */
const generatorFor = ({ degree, plaintextModulus, moduli }: RoundBfvParams) => {
  const key = `${degree}:${plaintextModulus}:${moduli.join(',')}`
  let generator = generators.get(key)
  if (!generator) {
    generator = new ZKInputsGenerator(Number(degree), plaintextModulus, BigInt64Array.from(moduli))
    generators.set(key, generator)
  }

  return generator
}

/**
 * Whether a serialized BFV public key is the one the committee produced.
 *
 * Every key blob is an untrusted transport value; the authority is the commitment the coordinator
 * stores behind a verified DKG proof. The comparison is on the recomputed commitment, not on bytes,
 * because decoding a threshold-aggregated key normalizes an internal flag, so a decode/re-encode
 * cycle is not a stable byte-for-byte check.
 *
 * Bytes that do not decode as a key for the parameters are an ordinary "no", not an exception:
 * candidates come from publishers, and one junk blob must not abort the search.
 *
 * @param publicKey - The serialized key to check
 * @param expectedCommitment - The round's on-chain key commitment (32 bytes, hex)
 * @param params - The round's BFV parameters
 * @returns Whether the key's commitment equals `expectedCommitment`
 */
export const isCommitteeKeyAuthentic = (publicKey: Uint8Array, expectedCommitment: string, params: RoundBfvParams): boolean => {
  if (publicKey.length === 0 || !isHex(expectedCommitment) || size(expectedCommitment) !== 32) return false

  let actual: Uint8Array
  try {
    actual = generatorFor(params).computePkCommitment(publicKey)
  } catch {
    return false
  }

  return bytesToHex(actual) === expectedCommitment.toLowerCase()
}

/**
 * Get a round's committee public key from the chain, verified against its on-chain commitment.
 *
 * Reads the candidates announced on the ciphernode registry ({@link getCommitteePublicKeyCandidates})
 * and returns the first whose recomputed BFV commitment equals the coordinator's
 * `committeePublicKey`. A candidate is a transport hint that any committee member may publish, so
 * the commitment check is what makes the key safe to encrypt to; encrypting to an unverified key
 * lets whoever supplied it decrypt the ballot.
 *
 * Replaces the server's `state/lite` key. The commitment is only set once the round reaches
 * `KeyPublished`, and the key bytes follow in separate transactions, so a round that has just
 * reached that stage may have no verifiable key yet.
 *
 * @param options - The coordinator, the round and the chain
 * @param options.fromBlock - First block to scan. Defaults to the block of the round's request.
 * @param options.toBlock - Last block to scan. Defaults to the chain head.
 * @param options.maxCandidates - Candidates to verify before giving up. Defaults to {@link MAX_COMMITTEE_KEY_CANDIDATES}.
 * @returns The committee public key bytes
 * @throws If the round has no key commitment yet, or no candidate matches it
 */
export const getCommitteePublicKey = async (
  options: RoundReadOptions & { fromBlock?: bigint; toBlock?: bigint; maxCandidates?: number },
): Promise<Uint8Array> => {
  const { e3Id, maxCandidates = MAX_COMMITTEE_KEY_CANDIDATES } = options
  const state = await getRoundState(options)

  if (/^0x0*$/.test(state.committeePublicKeyCommitment)) {
    throw new Error(`Round ${e3Id} has no committee key commitment on-chain yet (stage ${state.stage})`)
  }

  const [params, fromBlock] = await Promise.all([
    getRoundBfvParams(options),
    options.fromBlock ?? blockAtTimestamp(getPublicClient(options.chainId, options.rpcUrl), state.requestTime),
  ])

  const candidates = await getCommitteePublicKeyCandidates({ ...options, fromBlock })
  for (const { publicKey } of candidates) {
    if (isCommitteeKeyAuthentic(publicKey, state.committeePublicKeyCommitment, params)) return publicKey
  }

  const capped = candidates.length >= maxCandidates ? ` (the cap of ${maxCandidates}; later candidates were not read)` : ''
  throw new Error(
    candidates.length === 0
      ? `No committee key has been published on-chain for round ${e3Id}`
      : `None of the ${candidates.length} committee key candidate(s)${capped} for round ${e3Id} matches the on-chain commitment`,
  )
}
