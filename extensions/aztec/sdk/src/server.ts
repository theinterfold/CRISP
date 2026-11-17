// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { bytesToHex, type Address, type Hex } from 'viem'

import type { StagingPass } from './staging-pass'

/** `GET voting/remote-input/config`: how the CRISP server is wired for rounds collected on an L2. */
export type RemoteInputConfig = {
  kind: string
  chain_id: number
  program: Address
  aztec_node_url: string
  aztec_contract: Hex
  signer: Address
  /** The signer's secp256k1 public key, `0x` + 64 bytes (`x ‖ y`): what `deployCrispAztec` takes as `availabilitySignerPublicKey`. */
  signer_public_key: Hex
  /** The L1 `ZKPassportRegistrar` the server relays registrations to (`POST /registration/l1`); absent when it is not configured. */
  zkpassport_registrar?: Address
  /** Staging passes one slot key may use per round (`STAGING_MAX_REQUESTS_PER_SLOT`); the circuit's `max_requests`. */
  staging_max_requests: number
}

/** The server's availability attestation for one staged ciphertext. */
export type InputAttestation = {
  inputId: Hex
  encryptedVoteHash: Hex
  /** Unix seconds; the contract refuses an attestation older than the block it lands in. */
  expiresAt: bigint
  /** 64-byte `r ‖ s` ECDSA signature (low-s) over the EIP-712 `InputAvailability` digest. */
  signature: Hex
  signer: Address
}

export type StageInputRequest = {
  e3Id: bigint
  slot: Address
  ciphertext: Uint8Array
  ciphertextCommitment: Hex
  parentIndexPlusOne: number
  /** Proves the sender holds a registered slot key without saying which (`buildStagingPass`); required for every request. */
  stagingPass: StagingPass
}

const failure = async (what: string, response: Response): Promise<Error> => {
  const body = await response.text()
  return new Error(`CRISP server ${what} failed (${response.status}): ${body}`)
}

/** Read how the server is wired to the Aztec network, so a client needs only the server URL. */
export const getRemoteInputConfig = async (serverUrl: string, fetchImpl: typeof fetch = fetch): Promise<RemoteInputConfig> => {
  const response = await fetchImpl(`${serverUrl}/voting/remote-input/config`)
  if (!response.ok) throw await failure('remote-input config', response)

  return (await response.json()) as RemoteInputConfig
}

/**
 * Stage a ciphertext with the CRISP server and receive the availability attestation the Aztec contract checks.
 *
 * The server stores the bytes durably before it signs, which is what lets the Secure Process read an input that
 * only its leaf is committed on chain. It does not see or verify the ballot proof: Aztec does. It verifies the staging
 * pass, which proves the request comes from some registered slot (see `staging-pass.ts`).
 */
export const stageInput = async (
  serverUrl: string,
  request: StageInputRequest,
  fetchImpl: typeof fetch = fetch,
): Promise<InputAttestation> => {
  const response = await fetchImpl(`${serverUrl}/voting/remote-input`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      round_id: request.e3Id.toString(),
      slot: request.slot,
      ciphertext: bytesToHex(request.ciphertext),
      ciphertext_commitment: request.ciphertextCommitment,
      parent_index_plus_one: request.parentIndexPlusOne,
      staging_pass: { proof: request.stagingPass.proof, public_inputs: request.stagingPass.publicInputs },
    }),
  })
  if (!response.ok) throw await failure('input staging', response)

  const body = (await response.json()) as {
    input_id: Hex
    encrypted_vote_hash: Hex
    expires_at: number | string
    signature: Hex
    signer: Address
  }

  return {
    inputId: body.input_id,
    encryptedVoteHash: body.encrypted_vote_hash,
    expiresAt: BigInt(body.expires_at),
    signature: body.signature,
    signer: body.signer,
  }
}

/**
 * Have the CRISP server send a voter's `ZKPassportRegistrar.register` transaction (`registerOnL1Calldata`). The voter needs no
 * wallet or funds: the proof binds the voter's slot, so the relayer can neither redirect nor alter the registration. The server
 * simulates the call first and answers 400 with the revert reason when it would fail.
 */
export const relayRegistrationOnL1 = async (serverUrl: string, calldata: Hex, fetchImpl: typeof fetch = fetch): Promise<{ txHash: Hex }> => {
  const response = await fetchImpl(`${serverUrl}/registration/l1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ calldata }),
  })
  if (!response.ok) throw await failure('L1 registration', response)

  const body = (await response.json()) as { txHash: Hex }

  return { txHash: body.txHash }
}
