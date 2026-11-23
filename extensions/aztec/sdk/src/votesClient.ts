// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { AztecAddress, EthAddress } from '@aztec-labs/aztec.js/addresses'
import { getAddress, type Address, type Hex, type PublicClient } from 'viem'

import type { TypedDataSigner } from './ballot'
import { CrispAztecVotesContract } from './bindings/CrispAztecVotes'
import type { CastArguments } from './cast'
import { stagingTreeFromLogs, type Census } from './census'
import { getEnrolledMessages, type L1ToL2Message } from './l1'
import type { VotesRoundConfig } from './messages'
import { castCallArguments, RoundClient, sharedDeployArguments, type SentTx, type SharedDeployParams } from './roundClient'
import type { AztecSession } from './session'
import { stagingKeyBinding } from './votes-staging'

/** Deploy `crisp_aztec_votes`. Deploy the `CRISPAztecVotesProgram` on L1 first, then `setL2Program` with the result. */
export const deployCrispAztecVotes = async (session: AztecSession, params: SharedDeployParams): Promise<CrispAztecVotes> => {
  const { contract } = await CrispAztecVotesContract.deploy(session.wallet, ...sharedDeployArguments(params)).send({
    from: session.address,
    fee: session.fee,
  })

  return new CrispAztecVotes(session, contract, getAddress(params.interfold))
}

/**
 * The `crisp_aztec_votes` contract as a voter or a keeper uses it. A slot's weight arrives with its ENROLL message
 * (`enroll`, permissionless); a slot must be enrolled before it stages a vote and before a mask names it.
 */
export class CrispAztecVotes extends RoundClient {
  constructor(
    session: AztecSession,
    readonly contract: CrispAztecVotesContract,
    interfold: Address,
  ) {
    super(session, interfold)
  }

  get address(): AztecAddress {
    return this.contract.address
  }

  /** Attach to a deployed contract: the wallet has to be told its instance and artifact before it can call it. */
  static async connect(session: AztecSession, address: AztecAddress | string): Promise<CrispAztecVotes> {
    const contractAddress = typeof address === 'string' ? AztecAddress.fromStringUnsafe(address) : address
    const instance = await session.node.getContract(contractAddress)
    if (!instance) throw new Error(`No contract is deployed at ${contractAddress} on this network`)
    await session.wallet.registerContract(instance, CrispAztecVotesContract.artifact)

    const contract = CrispAztecVotesContract.at(contractAddress, session.wallet)
    const { result } = await contract.methods.get_config().simulate({ from: session.address })

    return new CrispAztecVotes(session, contract, getAddress((result as { interfold: EthAddress }).interfold.toString()))
  }

  async isSlotEnrolled(e3Id: bigint, slot: Address): Promise<boolean> {
    return this.view<boolean>(this.contract.methods.is_slot_enrolled(this.roundIdFor(e3Id), BigInt(slot)))
  }

  /** The round's staging tree, rebuilt from its STAGING_KEY_BOUND logs: what `buildVotesStagingPass` proves membership of. */
  async getStagingTree(e3Id: bigint): Promise<Census> {
    return stagingTreeFromLogs(await this.logs('StagingKeyBound', { e3Id }))
  }

  /**
   * Bind `slot`'s staging secret, which a staging pass later proves without naming the slot (enroll the slot first). The wallet
   * signs `StagingKey`; the secret and its commitment derive from the signature. If that commitment is already bound for the
   * slot (a deterministic signer signing again) the secret is returned without a transaction; else a new bind is sent (the contract
   * allows 3 per slot and round). Keep the secret (`stagingSecretStore`): a non-deterministic signer cannot re-derive it.
   */
  async bindStagingKey(args: {
    e3Id: bigint
    slot: Address
    signer: TypedDataSigner
    /** The CRISP program on L1 (the EIP-712 verifying contract). */
    program: Address
    l1ChainId: number
  }): Promise<{ secret: bigint; commitment: bigint; tx?: SentTx }> {
    const binding = await stagingKeyBinding(args)
    const bound = await this.logs('StagingKeyBound', { e3Id: args.e3Id })
    if (bound.some((log) => log.commitment === binding.commitment && log.slot.toLowerCase() === args.slot.toLowerCase())) {
      return { secret: binding.secret, commitment: binding.commitment }
    }
    const tx = await this.send(
      this.contract.methods.bind_staging_key(
        this.roundIdFor(args.e3Id),
        BigInt(args.slot),
        Array.from(binding.publicKeyX),
        Array.from(binding.publicKeyY),
        Array.from(binding.signature),
      ),
    )

    return { secret: binding.secret, commitment: binding.commitment, tx }
  }

  /** Consume the ROUND message the votes program sent (`getVotesRound` rebuilds `config` from L1). */
  async openRound(config: VotesRoundConfig, message: L1ToL2Message): Promise<SentTx> {
    return this.send(
      this.contract.methods.open_round(
        config.roundId,
        config.numOptions,
        config.inputStart,
        config.inputEnd,
        config.inputLimit,
        await this.messageLeafIndex(message),
      ),
    )
  }

  /** Consume the KEY message `publishCommitteeKey` sent. */
  async publishKey(e3Id: bigint, committeePublicKey: Hex, message: L1ToL2Message): Promise<SentTx> {
    return this.send(
      this.contract.methods.publish_key(this.roundIdFor(e3Id), BigInt(committeePublicKey), await this.messageLeafIndex(message)),
    )
  }

  /** Consume one ENROLL message (`getEnrolledMessages`): adds `slot` with `weight` to the census. Permissionless. */
  async enroll(args: { e3Id: bigint; slot: Address; weight: bigint; message: L1ToL2Message }): Promise<SentTx> {
    return this.send(
      this.contract.methods.enroll(this.roundIdFor(args.e3Id), BigInt(args.slot), args.weight, await this.messageLeafIndex(args.message)),
    )
  }

  /** Commit a ballot (a vote or a mask) built by `buildCast`, with `credits` = the slot's weight. */
  async cast(args: CastArguments): Promise<SentTx> {
    return this.send(this.contract.methods.cast(...castCallArguments(this.roundIdFor(args.e3Id), args)))
  }

  /** Seal the round and send its input root to L1. Possible once the input window has ended. */
  async closeRound(e3Id: bigint): Promise<SentTx> {
    return this.send(this.contract.methods.close_round(this.roundIdFor(e3Id)))
  }
}

const ENROLLMENT_TIMEOUT_MS = 15 * 60_000
const ENROLLMENT_POLL_MS = 5_000

export type WaitForEnrollmentOptions = {
  votes: CrispAztecVotes
  l1: PublicClient
  /** The votes program on L1. */
  program: Address
  e3Id: bigint
  slots: readonly Address[]
  /** The L1 `enroll` transaction (the server's `tx_hash` or your own): waited for before the messages are read. */
  l1TxHash?: Hex
}

/**
 * Wait until every slot is enrolled on Aztec: L1 `enroll` mined → its ENROLL message is read from the `Enrolled` event → Aztec
 * `enroll` (anyone may send it; a keeper may beat this call to it) → the slot is in the census. Resolves with the census then.
 */
export const waitForEnrollment = async (options: WaitForEnrollmentOptions): Promise<Census> => {
  const { votes, l1, program, e3Id, slots } = options
  const deadline = Date.now() + ENROLLMENT_TIMEOUT_MS
  if (options.l1TxHash) await l1.waitForTransactionReceipt({ hash: options.l1TxHash })

  let lastError: unknown
  for (;;) {
    const missing: Address[] = []
    for (const slot of slots) if (!(await votes.isSlotEnrolled(e3Id, slot))) missing.push(slot)
    if (missing.length === 0) return votes.getCensus(e3Id)

    for (const { slot, weight, message } of await getEnrolledMessages(l1, program, e3Id, { slots: missing })) {
      try {
        await votes.enroll({ e3Id, slot, weight, message })
      } catch (error) {
        // A keeper may have consumed the message first; the next pass checks the slot again.
        lastError = error
      }
    }

    if (Date.now() > deadline) {
      throw new Error(`Slots ${missing.join(', ')} are not enrolled on Aztec in time${lastError ? `: ${String((lastError as Error).message)}` : ''}`)
    }
    await new Promise((resolve) => setTimeout(resolve, ENROLLMENT_POLL_MS))
  }
}
