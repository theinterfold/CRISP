// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import type { AztecAddress } from '@aztec-labs/aztec.js/addresses'
import { Fr } from '@aztec-labs/foundation/curves/bn254'
import { Capsule } from '@aztec-labs/stdlib/tx'
import { PROOF_CAPSULE_SLOT, PROOF_FIELDS, VK_FIELDS, fetchOuterVk } from '@zkpassport/aztec'
import { getProofData } from '@zkpassport/utils'

/** The part of a ZKPassport SDK `ProofResult` (mode `compressed`) that registration needs. */
export type CompressedProofResult = { proof?: string; vkeyHash?: string }

/**
 * Subproofs the outer circuit aggregates for a query: 4 for one that only binds the proof to the sender (`register`),
 * 5 when it also proves a minimum age (`register_with_age`) or a nationality rule (`register_with_nationality`), 6 for both
 * (`register_with_age_and_nationality`). See `registrationSubproofs`.
 */
export type OuterSubproofCount = 4 | 5 | 6

/**
 * Public inputs of an `outer_count_K` proof of ZKPassport circuits 0.23.0: `K + 6`, the last being the verification method
 * (`100` for an eMRTD chip read). `@zkpassport/aztec` counts `K + 5`, the 0.22.0 layout, so the count is kept here.
 */
export const outerPublicInputCount = (subproofs: OuterSubproofCount): number => subproofs + 6

/**
 * The proof capsule blob the verifier loads: `vk(115) ‖ proof(458) ‖ public_inputs(K + 6)`, one field per element. A
 * wrong-shaped blob would only surface on chain as "missing zkpassport proof capsule", so the shape is checked here.
 * The SDK emits field elements as bare hex, which `Fr.fromString` would misread, so each is parsed as hex.
 */
export const assembleProofCapsule = (parts: { vk: string[]; proof: string[]; publicInputs: string[] }, subproofs: OuterSubproofCount): Fr[] => {
  const want = outerPublicInputCount(subproofs)
  if (parts.vk.length !== VK_FIELDS || parts.proof.length !== PROOF_FIELDS || parts.publicInputs.length !== want) {
    throw new Error(
      `ZKPassport outer proof shape mismatch: vk ${parts.vk.length}/${VK_FIELDS}, proof ${parts.proof.length}/${PROOF_FIELDS}, ` +
        `public inputs ${parts.publicInputs.length}/${want} for outer_count_${subproofs}; this contract verifies circuits 0.23.0`,
    )
  }

  return [...parts.vk, ...parts.proof, ...parts.publicInputs].map((field) => Fr.fromHexString(field))
}

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
