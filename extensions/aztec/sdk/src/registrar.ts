// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { encodeFunctionData, parseAbi, type Address, type Hex } from 'viem'

/**
 * The part of `ZKPassportRegistrar` this package calls or reads: the registrar of a round that registers on L1. A voter's
 * proof is checked there against ZKPassport's root verifier, and `program.registerMember` then sends the voter's slot to Aztec
 * (the MEMBER message the keeper turns into `add_member_from_l1`).
 */
export const registrarAbi = parseAbi([
  'struct ProofVerificationData { bytes32 vkeyHash; bytes proof; bytes32[] publicInputs; }',
  'struct ServiceConfig { uint256 validityPeriodInSeconds; string domain; string scope; bool devMode; }',
  'struct ProofVerificationParams { bytes32 version; ProofVerificationData proofVerificationData; bytes committedInputs; ServiceConfig serviceConfig; }',
  'function register(uint256 e3Id, address slot, ProofVerificationParams params, string[] countries)',
  'function program() view returns (address)',
  'function rootVerifier() view returns (address)',
  'function domain() view returns (string)',
  'function validityPeriod() view returns (uint256)',
  'function used(uint256 e3Id, bytes32 identifier) view returns (bool)',
  'event Registered(uint256 indexed e3Id, address indexed slot, bytes32 identifier)',
])

/**
 * ZKPassport's `ProofVerificationParams`, the value its SDK's `getSolidityVerifierParameters` returns for a `compressed-evm`
 * proof. The registrar replaces `serviceConfig` with its own (the round's scope and domain), so what the caller puts there does not matter;
 * the field is part of the tuple the verifier takes.
 */
export type ZKPassportProofParams = {
  version: Hex
  proofVerificationData: { vkeyHash: Hex; proof: Hex; publicInputs: readonly Hex[] }
  committedInputs: Hex
  serviceConfig: { validityPeriodInSeconds: bigint; domain: string; scope: string; devMode: boolean }
}

/** The arguments of `ZKPassportRegistrar.register`. */
export type RegisterOnL1Args = {
  e3Id: bigint
  /** The voter's per-poll slot key: the address the proof was bound to (`senderAddress`) and the one Aztec registers. */
  slot: Address
  params: ZKPassportProofParams
  /** The round's nationality list (the registrar checks its hash against the one the program stored), empty without a rule. */
  countries: readonly string[]
}

/** Calldata for `ZKPassportRegistrar.register`: what the CRISP server relays (`POST /registration/l1`). */
export const registerOnL1Calldata = ({ e3Id, slot, params, countries }: RegisterOnL1Args): Hex =>
  encodeFunctionData({
    abi: registrarAbi,
    functionName: 'register',
    args: [e3Id, slot, { ...params, proofVerificationData: { ...params.proofVerificationData, publicInputs: [...params.proofVerificationData.publicInputs] } }, [...countries]],
  })
