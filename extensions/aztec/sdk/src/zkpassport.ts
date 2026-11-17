// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import type { AztecAddress } from '@aztec-labs/aztec.js/addresses'
import { Fr } from '@aztec-labs/foundation/curves/bn254'
import { Capsule } from '@aztec-labs/stdlib/tx'
import { PROOF_CAPSULE_SLOT, assembleProofCapsule, fetchOuterVk, outerPublicInputCount } from '@zkpassport/aztec'
import { getProofData } from '@zkpassport/utils'

/** The part of a ZKPassport SDK `ProofResult` (mode `compressed`) that registration needs. */
export type CompressedProofResult = { proof?: string; vkeyHash?: string }

/**
 * Subproofs the outer circuit aggregates for a query: 4 for one that only binds the proof to the sender (`register`),
 * 5 when it also proves a minimum age (`register_with_age`).
 */
export type OuterSubproofCount = 4 | 5

/**
 * Turn the outer proof of a ZKPassport `compressed` result into the capsule `register` consumes.
 *
 * The verifier library loads the proof from a capsule scoped to the account that sends the transaction, and the
 * circuit constrains every field it reads, so a wrong capsule makes the proof fail instead of being trusted.
 */
export const registrationCapsule = async (
  contract: AztecAddress,
  sender: AztecAddress,
  result: CompressedProofResult,
  subproofs: OuterSubproofCount,
): Promise<Capsule> => {
  if (!result.proof || !result.vkeyHash) throw new Error('A compressed ZKPassport proof result carries the outer proof and its vkey hash')
  const { proof, publicInputs } = getProofData(result.proof, outerPublicInputCount(subproofs))
  const vk = await fetchOuterVk(result.vkeyHash)
  const fields = assembleProofCapsule({ vk, proof, publicInputs }, subproofs)

  return new Capsule(contract, new Fr(PROOF_CAPSULE_SLOT), fields, sender)
}
