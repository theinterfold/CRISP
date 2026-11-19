// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import type { Address, Hex } from 'viem'

/** `GET voting/remote-input/config`: how the CRISP server is wired to the voting chain. */
export type GnosisConfig = {
  kind: 'gnosis'
  /** The voting chain's id: the chain id of the EIP-712 domain a voter signs. */
  chain_id: number
  voting_address: Address
  token_address: Address
  /** The Sepolia `CRISPGnosisProgram`. */
  program: Address
  rpc_url: string
  explorer_url?: string
  attestation_ttl: number
  /** The server's availability signer: the address `CrispGnosisVoting` accepts attestations from. */
  signer: Address
  faucet: { enabled: boolean; /** Wei per claim, as a decimal string. */ amount: string }
}

/** What the server answered to a ballot. */
export type BroadcastResult =
  /** The server relayed `publishInput` itself. */
  | { status: 'success'; txHash: Hex }
  /** The relay was off or full: send `publishInput(e3Id, payload)` from the voter's wallet. */
  | { status: 'ready_for_commitment'; payload: Hex }

const failure = async (what: string, response: Response): Promise<Error> => {
  const body = await response.text()

  return new Error(`CRISP server ${what} failed (${response.status}): ${body}`)
}

/** Read how the server is wired, so a client needs only the server URL. */
export const getConfig = async (serverUrl: string, fetchImpl: typeof fetch = fetch): Promise<GnosisConfig> => {
  const response = await fetchImpl(`${serverUrl}/voting/remote-input/config`)
  if (!response.ok) throw await failure('config', response)

  return (await response.json()) as GnosisConfig
}

/**
 * Hand a ballot (`encodeSolidityProof` of its proof) to the server. The server dry-runs it on the voting chain, stores
 * the ciphertext, signs the availability attestation and, with `sendFromWallet` false, sends `publishInput` itself
 * and answers once it is mined.
 */
export const broadcast = async (
  serverUrl: string,
  args: { e3Id: bigint; encodedProof: Hex; sendFromWallet?: boolean },
  fetchImpl: typeof fetch = fetch,
): Promise<BroadcastResult> => {
  const send = () =>
    fetchImpl(`${serverUrl}/voting/broadcast`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ round_id: args.e3Id.toString(), encoded_proof: args.encodedProof, send_from_wallet: args.sendFromWallet ?? false }),
    })
  // Proving blocks a Node event loop for seconds: the pooled connection the server closed meanwhile is reset when
  // reused. The request never reached the server then, so it is sent once more, on a new connection.
  const response = await send().catch(send)
  if (!response.ok) throw await failure('broadcast', response)

  const body = (await response.json()) as { status: string; tx_hash: Hex | null; encoded_proof: Hex | null; message: string | null }
  if (body.status === 'success' && body.tx_hash) return { status: 'success', txHash: body.tx_hash }
  if (body.status === 'ready_for_commitment' && body.encoded_proof) return { status: 'ready_for_commitment', payload: body.encoded_proof }

  throw new Error(`CRISP server broadcast answered ${body.status}: ${body.message ?? 'no message'}`)
}

/** Ask the server's faucet to mint the demo token to `address` (the server pays the gas). */
export const claimFaucet = async (
  serverUrl: string,
  address: Address,
  fetchImpl: typeof fetch = fetch,
): Promise<{ txHash: Hex; amount: bigint }> => {
  const response = await fetchImpl(`${serverUrl}/faucet`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ address }),
  })
  if (!response.ok) throw await failure('faucet', response)

  const body = (await response.json()) as { tx_hash: Hex; amount: string }

  return { txHash: body.tx_hash, amount: BigInt(body.amount) }
}
