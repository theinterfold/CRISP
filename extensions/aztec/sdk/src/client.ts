// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { AztecAddress, EthAddress } from '@aztec-labs/aztec.js/addresses'
import { waitForL1ToL2MessageReady } from '@aztec-labs/aztec.js/messaging'
import { Fr } from '@aztec-labs/foundation/curves/bn254'
import type { ContractFunctionInteraction } from '@aztec-labs/aztec.js/contracts'
import type { Capsule } from '@aztec-labs/stdlib/tx'
import { registerZKPassportRegistry } from '@zkpassport/aztec'
import { getAddress, hexToBytes, type Address, type Hex } from 'viem'

import { type CastArguments } from './cast'
import { type Census, censusFromLogs } from './census'
import { CrispAztecContract } from './bindings/CrispAztec'
import type { L1ToL2Message } from './l1'
import { readLogs, type ReadLogsOptions } from './logs'
import { e3IdOf, type RoundConfig, roundIdOf } from './messages'
import type { AztecSession } from './session'
import { registrationSubproofs } from './rules'
import { type CompressedProofResult, registrationCapsule } from './zkpassport'

/** The round parameters the contract stored from the ROUND message. */
export type RoundParams = {
  numOptions: bigint
  credits: bigint
  inputStart: bigint
  inputEnd: bigint
  inputLimit: bigint
  scopeHash: bigint
  minAge: bigint
  allowMockDocuments: boolean
  /** The voters register on L1 (the round's `ZKPassportRegistrar`); `register` is not available. */
  l1Registration: boolean
  /** `NATIONALITY_MODE`: 0 none, 1 nationality in the list, 2 not in it. */
  nationalityMode: number
  /** ZKPassport commitment of the nationality list an Aztec-path round's proof is checked against; 0 otherwise. */
  nationalityCommitment: bigint
}

/** What a transaction sent through this client reports. */
export type SentTx = { txHash: string; blockNumber?: number }

/** Seconds to wait for an L1→L2 message to be included in an L2 block before giving up. */
const MESSAGE_TIMEOUT_SECONDS = 600

const bytes32 = (hex: Hex): number[] => Array.from(hexToBytes(hex, { size: 32 }))

/** The 10 values the contract is deployed with; see `deployCrispAztec`. */
export type DeployParams = {
  l1Program: Address
  /** The Interfold the program serves: its address is the top 20 bytes of every e3Id of the round ids this contract tracks. */
  interfold: Address
  /** Domain separator of the L1 program's EIP-712 domain; both statements share it (see `domainSeparator`). */
  domainSeparator: Hex
  /** The availability signer's secp256k1 public key: 64 bytes `x ‖ y`, or the 65-byte uncompressed form with its `04` prefix. */
  availabilitySignerPublicKey: Hex
  /** Hash of the fold circuit's `noir-recursive` verification key (`getFoldRecursiveVerificationKey`). */
  foldVkHash: bigint
  zkpassportDomainHash: bigint
  /** The ZKPassport circuits release, packed (`0x16` in the top byte for 0.22.0). */
  zkpassportCircuitVersion: bigint
  zkpassportValiditySeconds: bigint
  zkpassportRegistry: AztecAddress
}

/** Deploy `crisp_aztec`. Deploy the L1 program first (its address is a constructor argument), then call `setL2Program` with the result. */
export const deployCrispAztec = async (session: AztecSession, params: DeployParams): Promise<CrispAztec> => {
  const given = hexToBytes(params.availabilitySignerPublicKey)
  const key = given.length === 65 && given[0] === 4 ? given.slice(1) : given
  if (key.length !== 64)
    throw new Error('The availability signer key must be an uncompressed secp256k1 public key (64 bytes, or 65 with the 04 prefix)')
  const separator = bytes32(params.domainSeparator)

  const { contract } = await CrispAztecContract.deploy(
    session.wallet,
    EthAddress.fromString(params.l1Program),
    EthAddress.fromString(params.interfold),
    separator,
    separator,
    Array.from(key.slice(0, 32)),
    Array.from(key.slice(32, 64)),
    new Fr(params.foldVkHash),
    new Fr(params.zkpassportDomainHash),
    new Fr(params.zkpassportCircuitVersion),
    params.zkpassportValiditySeconds,
    params.zkpassportRegistry,
  ).send({ from: session.address, fee: session.fee })

  return new CrispAztec(session, contract, getAddress(params.interfold))
}

/**
 * The `crisp_aztec` contract as a voter or a keeper uses it. Every method that sends a transaction waits for its
 * inclusion; none of them needs the round to be known in advance, because each reads what it needs.
 */
export class CrispAztec {
  constructor(
    readonly session: AztecSession,
    readonly contract: CrispAztecContract,
    /** The Interfold whose e3Ids this contract serves; the contract itself only knows their low 96 bits. */
    readonly interfold: Address,
  ) {}

  get address(): AztecAddress {
    return this.contract.address
  }

  /** Attach to a deployed contract: the wallet has to be told its instance and artifact before it can call it. */
  static async connect(session: AztecSession, address: AztecAddress | string): Promise<CrispAztec> {
    const contractAddress = typeof address === 'string' ? AztecAddress.fromStringUnsafe(address) : address
    const instance = await session.node.getContract(contractAddress)
    if (!instance) throw new Error(`No contract is deployed at ${contractAddress} on this network`)
    await session.wallet.registerContract(instance, CrispAztecContract.artifact)

    const contract = CrispAztecContract.at(contractAddress, session.wallet)
    const { result } = await contract.methods.get_config().simulate({ from: session.address })

    return new CrispAztec(session, contract, getAddress((result as { interfold: EthAddress }).interfold.toString()))
  }

  /** The id the contract keys a round by. */
  roundIdFor(e3Id: bigint): bigint {
    this.assertOwnRound(e3Id)

    return roundIdOf(e3Id)
  }

  private assertOwnRound(e3Id: bigint): void {
    if (e3IdOf(this.interfold, roundIdOf(e3Id)) !== e3Id) throw new Error(`e3Id ${e3Id} does not belong to Interfold ${this.interfold}`)
  }

  // ---------------------------------------------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------------------------------------------

  private async view<T>(call: ContractFunctionInteraction): Promise<T> {
    const { result } = await call.simulate({ from: this.session.address })

    return result as T
  }

  /** `undefined` until `open_round` has consumed the ROUND message. */
  async getRound(e3Id: bigint): Promise<RoundParams | undefined> {
    if ((await this.logs('RoundOpened', { e3Id })).length === 0) return undefined
    const round = await this.view<{
      num_options: bigint
      credits: bigint
      input_start: bigint
      input_end: bigint
      input_limit: bigint
      scope_hash: bigint
      min_age: bigint
      allow_mock_documents: boolean
      l1_registration: boolean
      nationality_mode: bigint
      nationality_commitment: bigint
    }>(this.contract.methods.get_round(this.roundIdFor(e3Id)))

    return {
      numOptions: BigInt(round.num_options),
      credits: BigInt(round.credits),
      inputStart: BigInt(round.input_start),
      inputEnd: BigInt(round.input_end),
      inputLimit: BigInt(round.input_limit),
      scopeHash: BigInt(round.scope_hash),
      minAge: BigInt(round.min_age),
      allowMockDocuments: round.allow_mock_documents,
      l1Registration: round.l1_registration,
      nationalityMode: Number(round.nationality_mode),
      nationalityCommitment: BigInt(round.nationality_commitment),
    }
  }

  /** The committee key commitment from the KEY message; `undefined` until `publish_key` has consumed it. */
  async getCommitteeKey(e3Id: bigint): Promise<Hex | undefined> {
    const [published] = await this.logs('KeyPublished', { e3Id })

    return published?.committeePublicKey
  }

  async isClosed(e3Id: bigint): Promise<boolean> {
    return (await this.logs('RoundClosed', { e3Id })).length > 0
  }

  async getInputCount(e3Id: bigint): Promise<number> {
    return Number(await this.view<bigint>(this.contract.methods.get_input_count(this.roundIdFor(e3Id))))
  }

  async isSlotRegistered(e3Id: bigint, slot: Address): Promise<boolean> {
    return this.view<boolean>(this.contract.methods.is_slot_registered(this.roundIdFor(e3Id), BigInt(slot)))
  }

  /** Public logs of one kind this contract emitted, oldest first. */
  logs<K extends Parameters<typeof readLogs>[2]>(kind: K, options: ReadLogsOptions & { e3Id?: bigint } = {}) {
    return readLogs(this.session.node, this.contract.address, kind, this.interfold, options)
  }

  /** The census of a round, rebuilt from its MEMBER_REGISTERED logs. */
  async getCensus(e3Id: bigint): Promise<Census> {
    return censusFromLogs(await this.logs('MemberRegistered', { e3Id }))
  }

  // ---------------------------------------------------------------------------------------------------------
  // Transactions
  // ---------------------------------------------------------------------------------------------------------

  private async send(call: ContractFunctionInteraction, capsules?: Capsule[]): Promise<SentTx> {
    const { receipt } = await call.send({ from: this.session.address, fee: this.session.fee, capsules })

    return { txHash: receipt.txHash.toString(), blockNumber: receipt.blockNumber === undefined ? undefined : Number(receipt.blockNumber) }
  }

  /** The leaf index `consume_l1_to_l2_message` needs, once an L2 block has included the Inbox message. */
  private async messageLeafIndex(message: L1ToL2Message): Promise<bigint> {
    const leaf = Fr.fromHexString(message.leaf)
    if (!(await waitForL1ToL2MessageReady(this.session.node, leaf, { timeoutSeconds: MESSAGE_TIMEOUT_SECONDS }))) {
      throw new Error(`The L1→L2 message ${message.leaf} was not included in an L2 block in time`)
    }
    // Blocks insert Inbox messages in order into consecutive leaves, so the node's index of the message is its leaf index.
    const index = await this.session.node.getL1ToL2MessageIndex(leaf)
    if (index === undefined) throw new Error(`The node does not know the L1→L2 message ${message.leaf}`)

    return index
  }

  /** Consume the ROUND message `Interfold.request` sent. `config` is rebuilt from L1 (`getRoundConfig`) and must hash to `message.content`. */
  async openRound(config: RoundConfig, message: L1ToL2Message): Promise<SentTx> {
    return this.send(
      this.contract.methods.open_round(
        config.roundId,
        config.numOptions,
        config.credits,
        config.inputStart,
        config.inputEnd,
        config.inputLimit,
        config.scopeHash,
        config.minAge,
        config.allowMockDocuments,
        config.l1Registration,
        config.nationalityMode,
        config.nationalityCommitment,
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

  /**
   * Register `slot` for a round that registers on Aztec, with a ZKPassport proof bound to this session's account
   * (`session.address`) and to the round's scope. The proof is the `compressed`-mode result of the ZKPassport SDK; it must
   * show what the round asks (its minimum age and nationality rule), which also selects the entry point: `register`,
   * `register_with_age`, `register_with_nationality` or `register_with_age_and_nationality`.
   */
  async register(args: { e3Id: bigint; slot: Address; proof: CompressedProofResult }): Promise<SentTx> {
    const round = await this.getRound(args.e3Id)
    if (!round) throw new Error(`Round ${args.e3Id} is not open on Aztec yet`)
    if (round.l1Registration) throw new Error(`Round ${args.e3Id} registers on L1: use the registrar (registerOnL1Calldata), not Aztec`)

    // The verifier library `.view()`s the registry privately, so this wallet's PXE has to know its artifact.
    const { zkpassport_registry } = await this.view<{ zkpassport_registry: AztecAddress }>(this.contract.methods.get_config())
    await registerZKPassportRegistry(this.session.wallet, this.session.node, zkpassport_registry)

    // A query's size is fixed at compile time, so each combination of rules has its own entry point.
    const roundId = this.roundIdFor(args.e3Id)
    const slot = BigInt(args.slot)
    const withAge = round.minAge > 0n
    const withNationality = round.nationalityMode !== 0
    const capsule = await registrationCapsule(this.contract.address, this.session.address, args.proof, registrationSubproofs(round))
    const methods = this.contract.methods
    const call =
      withAge && withNationality
        ? methods.register_with_age_and_nationality(roundId, slot)
        : withAge
          ? methods.register_with_age(roundId, slot)
          : withNationality
            ? methods.register_with_nationality(roundId, slot)
            : methods.register(roundId, slot)

    return this.send(call, [capsule])
  }

  /**
   * Add `slot` to the census of a round that registers on L1, from the MEMBER message the registrar's program sent for it
   * (`getSentMembers`). Permissionless: the message authenticates the slot. Fails if the slot is already registered.
   */
  async addMemberFromL1(e3Id: bigint, slot: Address, message: L1ToL2Message): Promise<SentTx> {
    return this.send(this.contract.methods.add_member_from_l1(this.roundIdFor(e3Id), BigInt(slot), await this.messageLeafIndex(message)))
  }

  /** Commit a ballot (a vote or a mask) built by `buildCast`. */
  async cast(args: CastArguments): Promise<SentTx> {
    return this.send(
      this.contract.methods.cast(
        this.roundIdFor(args.e3Id),
        args.vk,
        args.proof,
        BigInt(args.slot),
        BigInt(args.ctCommitment),
        bytes32(args.encryptedVoteHash),
        args.parentIndexPlusOne,
        args.prevCommitment,
        args.censusRoot,
        args.expiresAt,
        Array.from(hexToBytes(args.signature, { size: 64 })),
      ),
    )
  }

  /** Seal the round and send its input root to L1. Possible once the input window has ended. */
  async closeRound(e3Id: bigint): Promise<SentTx> {
    return this.send(this.contract.methods.close_round(this.roundIdFor(e3Id)))
  }
}
