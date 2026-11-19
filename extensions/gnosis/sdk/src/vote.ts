// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { CrispSDK, encodeSolidityProof, getZeroVote, type ProofProgress } from '@crisp-e3/sdk'
import type { Address, Hex, PublicClient, WalletClient } from 'viem'

import { crispGnosisVotingAbi } from './abi/CrispGnosisVoting'
import { EIP712_NAME, EIP712_VERSION, NUM_OPTIONS } from './constants'
import { broadcast, type BroadcastResult } from './server'

type CastCommon = {
  /** The CRISP server. */
  serverUrl: string
  /** The full Interfold e3Id of the proposal's round. */
  e3Id: bigint
  /** `CrispGnosisVoting`. */
  voting: Address
  /** The voting chain's id (`GnosisConfig.chain_id`): the chain id of the EIP-712 domain the ballot is signed under. */
  chainId: number
  /** A client of the voting chain, for reads only: a voter needs no gas there. */
  chiado: PublicClient
  /** Called as each proof stage starts; proving takes minutes in a browser. */
  onProgress?: (progress: ProofProgress) => void
  /** Ask the server for the `publishInput` payload instead of letting it send the transaction (then call {@link submitInput}). */
  sendFromWallet?: boolean
}

export type CastResult = { encodedProof: Hex; result: BroadcastResult }

const BALLOT_TYPES = {
  Ballot: [
    { name: 'e3Id', type: 'uint256' },
    { name: 'slot', type: 'address' },
    { name: 'ciphertextCommitment', type: 'bytes32' },
  ],
} as const

/** The EIP-712 domain of `CrispGnosisVoting`: what a voter's wallet is asked to sign the ballot under. */
export const ballotDomain = (chainId: number, voting: Address) =>
  ({ name: EIP712_NAME, version: EIP712_VERSION, chainId: BigInt(chainId), verifyingContract: voting }) as const

/**
 * Encrypt, prove and send one ballot: `slot` puts `weight` of its voting power (default: all of it) on `choice`, or, for a
 * mask, nothing.
 *
 * The circuit preset must be registered first: `setCircuits(await loadCircuits())`, with `setCircuits` from
 * `@crisp-e3/sdk` and `loadCircuits` from the preset subpath of `@crisp-e3/sdk` that matches the round.
 */
const cast = async (
  args: CastCommon & { slot: Address; choice?: number; weight?: bigint; sign?: (ciphertextCommitment: Hex) => Promise<Hex> },
): Promise<CastResult> => {
  const { serverUrl, e3Id, voting, chiado, slot } = args
  const isMask = args.choice === undefined
  const crisp = new CrispSDK(serverUrl)

  const votingPower = await chiado.readContract({ address: voting, abi: crispGnosisVotingAbi, functionName: 'votingPowerOf', args: [e3Id, slot] })
  if (votingPower === 0n) throw new Error(`${slot} has no voting power in round ${e3Id}: its tokens were not delegated before the proposal`)
  if (votingPower > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`Voting power ${votingPower} does not fit a ballot weight`)

  const vote = getZeroVote(NUM_OPTIONS)
  if (!isMask) {
    if (!Number.isInteger(args.choice) || args.choice! < 0 || args.choice! >= NUM_OPTIONS) throw new Error(`Choice must be 0 to ${NUM_OPTIONS - 1}`)
    const weight = args.weight ?? votingPower
    if (weight < 1n || weight > votingPower) throw new Error(`Weight must be 1 to ${votingPower} ballot units`)
    vote[args.choice!] = Number(weight)
  }

  const publicKey = await crisp.getRoundPublicKey(e3Id)
  const prepared = await crisp.prepareBallot({
    censusMode: 'onchain',
    e3Id,
    slotAddress: slot,
    publicKey,
    isMaskVote: isMask,
    numOptions: NUM_OPTIONS,
    vote,
    votingPower,
    programAddress: voting,
    chainId: args.chainId,
  })

  // Read the digest from the contract: one implementation of the domain, and it binds the ciphertext just prepared.
  const digest = await chiado.readContract({
    address: voting,
    abi: crispGnosisVotingAbi,
    functionName: 'ballotDigest',
    args: [e3Id, slot, prepared.ctCommitment],
  })
  const signature = isMask ? undefined : await args.sign!(prepared.ctCommitment)
  const proof = await crisp.finishBallot(prepared, digest, signature, { onProgress: args.onProgress })

  // The fold proof exposes (prevCommitment, digestHi, digestLo, slot, votingPower, isFirstVote, numOptions, ctCommitment, key).
  if (BigInt(proof.publicInputs[3]) !== BigInt(slot)) throw new Error('The proof is for another slot than the one asked for')
  if (BigInt(proof.publicInputs[4]) !== votingPower) throw new Error('The proof carries another voting power than the contract reports')

  const encodedProof = encodeSolidityProof(proof)
  const result = await broadcast(serverUrl, { e3Id, encodedProof, sendFromWallet: args.sendFromWallet })

  return { encodedProof, result }
}

/**
 * Vote with `wallet`'s account as the slot: one EIP-712 `Ballot` signature, no gas on the voting chain. The wallet's chain
 * must be the voting chain when it enforces the domain (MetaMask does): switch it before calling.
 *
 * `weight` is the part of the voting power to use, in ballot units (`votingPowerOf`), 1 to all of it (the default). The proof
 * and the chain carry the full voting power either way, so only the voter knows how much went into the tally.
 */
export const castBallot = (args: CastCommon & { wallet: WalletClient; choice: number; weight?: bigint }): Promise<CastResult> => {
  const account = args.wallet.account
  if (!account) throw new Error('The wallet has no account')

  return cast({
    ...args,
    slot: account.address,
    sign: (ciphertextCommitment) =>
      args.wallet.signTypedData({
        account,
        domain: ballotDomain(args.chainId, args.voting),
        types: BALLOT_TYPES,
        primaryType: 'Ballot',
        message: { e3Id: args.e3Id, slot: account.address, ciphertextCommitment },
      }),
  })
}

/**
 * Add a mask to `slot`: a zero ballot that adds nothing to the tally and, on chain, looks like any other input. It needs
 * no signature, so anyone may mask any slot that has voting power.
 */
export const castMask = (args: CastCommon & { slot: Address }): Promise<CastResult> => cast(args)

/** Send the payload the server handed back (`sendFromWallet`) to the voting contract from the voter's own wallet. */
export const submitInput = async (
  wallet: WalletClient,
  chiado: PublicClient,
  voting: Address,
  e3Id: bigint,
  payload: Hex,
): Promise<Hex> => {
  const { request } = await chiado.simulateContract({
    address: voting,
    abi: crispGnosisVotingAbi,
    functionName: 'publishInput',
    args: [e3Id, payload],
    account: wallet.account,
  })

  return wallet.writeContract(request)
}
