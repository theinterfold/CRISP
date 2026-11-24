// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { AztecAddress, EthAddress } from '@aztec-labs/aztec.js/addresses'
import { getAddress, toHex, type Address, type Hex, type PublicClient } from 'viem'

import type { TypedDataSigner } from './ballot'
import { CrispAztecVotesContract } from './bindings/CrispAztecVotes'
import type { CastArguments } from './cast'
import { censusFromLogs, stagingTreeFromLogs, type Census } from './census'
import { getEnrolledMessages, type EnrolledMessage, type L1ToL2Message } from './l1'
import type { VotesRoundConfig } from './messages'
import { castCallArguments, RoundClient, sharedDeployArguments, type SentTx, type SharedDeployParams } from './roundClient'
import { requestEnrollment } from './server'
import type { AztecSession } from './session'
import { stagingCommitment, stagingKeyBinding, type SecretStorage } from './votes-staging'

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

  /**
   * The staging secret of `slot` in the round, and the staging tree that holds its commitment: what a staging pass proves without
   * naming the slot. The secret kept in `storage` is used when its commitment is bound. Else the wallet signs `StagingKey`, the
   * secret derives from the signature, and `bind_staging_key` binds its commitment unless it is bound already (a deterministic
   * signer signing again). The slot must be enrolled first. The contract allows 3 binds per slot and round, which is why the
   * secret is stored: a signer that signs differently each time cannot derive it again.
   */
  async stagingKey(args: {
    e3Id: bigint
    slot: Address
    signer: TypedDataSigner
    /** The CRISP program on L1 (the EIP-712 verifying contract). */
    program: Address
    l1ChainId: number
    storage: SecretStorage
  }): Promise<{ secret: bigint; stagingTree: Census }> {
    const { e3Id, slot, storage } = args
    const roundId = this.roundIdFor(e3Id)
    const key = `crisp-aztec-votes:staging-secret:${args.program.toLowerCase()}:${e3Id}:${slot.toLowerCase()}`
    let bound = await this.logs('StagingKeyBound', { e3Id })
    // A commitment enters a round's staging tree once, and only its slot's signature derives it.
    const isBound = (secret: bigint) => bound.some((log) => log.commitment === stagingCommitment(secret, roundId))

    const stored = await storage.get(key)
    let secret = stored ? BigInt(stored) : undefined
    if (secret === undefined || !isBound(secret)) {
      const binding = await stagingKeyBinding(args)
      secret = binding.secret
      if (!isBound(secret)) {
        await this.send(
          this.contract.methods.bind_staging_key(
            roundId,
            BigInt(slot),
            Array.from(binding.publicKeyX),
            Array.from(binding.publicKeyY),
            Array.from(binding.signature),
          ),
        )
        bound = await this.logs('StagingKeyBound', { e3Id })
      }
      await storage.set(key, toHex(secret))
    }

    return { secret, stagingTree: stagingTreeFromLogs(bound) }
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
  async enroll(args: { e3Id: bigint } & EnrolledMessage): Promise<SentTx> {
    return this.send(
      this.contract.methods.enroll(this.roundIdFor(args.e3Id), BigInt(args.slot), args.weight, await this.messageLeafIndex(args)),
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

/**
 * Make sure every slot is in the round's census on Aztec, and return the census. A missing slot is enrolled: the CRISP server
 * relays the permissionless L1 `enroll` (the voter pays nothing), the slot's ENROLL message is read from the `Enrolled` event, and
 * Aztec `enroll` consumes it. Anyone may send that last step, so a keeper may get there first.
 */
export const ensureEnrolled = async (options: {
  votes: CrispAztecVotes
  l1: PublicClient
  /** The votes program on L1. */
  program: Address
  e3Id: bigint
  slots: readonly Address[]
  serverUrl: string
  /** Called with the slots that are about to be enrolled, which takes minutes. */
  onEnrolling?: (slots: Address[]) => void
}): Promise<Census> => {
  const { votes, l1, program, e3Id } = options
  const read = async () => {
    const members = await votes.logs('MemberRegistered', { e3Id })
    const enrolled = new Set(members.map((log) => log.slot.toLowerCase()))

    return { members, missing: options.slots.filter((slot) => !enrolled.has(slot.toLowerCase())) }
  }

  let { members, missing } = await read()
  if (missing.length === 0) return censusFromLogs(members)

  options.onEnrolling?.(missing)
  const { txHash, skipped } = await requestEnrollment(options.serverUrl, e3Id, missing)
  // `enrolled` and `in_flight` mean the weight is already on its way to Aztec; only a slot without power is refused.
  const refused = skipped.find(({ reason }) => reason === 'no_weight')
  if (refused) throw new Error(`${refused.slot} has no voting power in this round`)
  if (txHash) await l1.waitForTransactionReceipt({ hash: txHash })

  const deadline = Date.now() + ENROLLMENT_TIMEOUT_MS
  let lastError: unknown
  for (;;) {
    for (const enrollment of await getEnrolledMessages(l1, program, e3Id, { slots: missing })) {
      // A keeper may consume the message first; the next read of the census tells.
      await votes.enroll({ e3Id, ...enrollment }).catch((error) => (lastError = error))
    }
    ;({ members, missing } = await read())
    if (missing.length === 0) return censusFromLogs(members)
    if (Date.now() > deadline) {
      throw new Error(`Slots ${missing.join(', ')} were not enrolled on Aztec in time${lastError ? `: ${String((lastError as Error).message)}` : ''}`)
    }
    await new Promise((resolve) => setTimeout(resolve, ENROLLMENT_POLL_MS))
  }
}
