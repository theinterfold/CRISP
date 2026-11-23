// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { EthAddress, type AztecAddress } from '@aztec-labs/aztec.js/addresses'
import type { ContractFunctionInteraction } from '@aztec-labs/aztec.js/contracts'
import { waitForL1ToL2MessageReady } from '@aztec-labs/aztec.js/messaging'
import { Fr } from '@aztec-labs/foundation/curves/bn254'
import type { Capsule } from '@aztec-labs/stdlib/tx'
import { hexToBytes, type Address, type Hex } from 'viem'

import type { CastArguments } from './cast'
import { type Census, censusFromLogs } from './census'
import type { L1ToL2Message } from './l1'
import { readLogs, type ReadLogsOptions } from './logs'
import { e3IdOf, roundIdOf } from './messages'
import type { AztecSession } from './session'

/** What a transaction sent through a client reports. */
export type SentTx = { txHash: string; blockNumber?: number }

/** Seconds to wait for an L1→L2 message to be included in an L2 block before giving up. */
const MESSAGE_TIMEOUT_SECONDS = 600

const bytes32 = (hex: Hex): number[] => Array.from(hexToBytes(hex, { size: 32 }))

/** The values both contracts are deployed with first; see `deployCrispAztec` and `deployCrispAztecVotes`. */
export type SharedDeployParams = {
  l1Program: Address
  /** The Interfold the program serves: its address is the top 20 bytes of every e3Id of the round ids this contract tracks. */
  interfold: Address
  /** Domain separator of the L1 program's EIP-712 domain; both statements share it (see `domainSeparator`). */
  domainSeparator: Hex
  /** The availability signer's secp256k1 public key: 64 bytes `x ‖ y`, or the 65-byte uncompressed form with its `04` prefix. */
  availabilitySignerPublicKey: Hex
  /**
   * Hashes of the verification keys of the three base circuits of the BFV preset the deployment serves
   * (`getBaseVerificationKeys` of `@crisp-e3/sdk`, with the preset registered): a ballot is proven with exactly these.
   */
  ct0VkHash: bigint
  ct1VkHash: bigint
  crispVkHash: bigint
}

/** The leading constructor arguments of both contracts. */
export const sharedDeployArguments = (params: SharedDeployParams) => {
  const given = hexToBytes(params.availabilitySignerPublicKey)
  const key = given.length === 65 && given[0] === 4 ? given.slice(1) : given
  if (key.length !== 64)
    throw new Error('The availability signer key must be an uncompressed secp256k1 public key (64 bytes, or 65 with the 04 prefix)')
  const separator = bytes32(params.domainSeparator)

  return [
    EthAddress.fromString(params.l1Program),
    EthAddress.fromString(params.interfold),
    separator,
    separator,
    Array.from(key.slice(0, 32)),
    Array.from(key.slice(32, 64)),
    new Fr(params.ct0VkHash),
    new Fr(params.ct1VkHash),
    new Fr(params.crispVkHash),
  ] as const
}

/** The arguments of `cast`, which both CRISP contracts take identically. */
export const castCallArguments = (roundId: bigint, args: CastArguments) =>
  [
    roundId,
    args.ct0Vk,
    args.ct0Proof,
    args.ct0PublicInputs,
    args.ct1Vk,
    args.ct1Proof,
    args.ct1PublicInputs,
    args.crispVk,
    args.crispProof,
    BigInt(args.slot),
    BigInt(args.ctCommitment),
    bytes32(args.encryptedVoteHash),
    args.parentIndexPlusOne,
    args.prevCommitment,
    args.censusRoot,
    args.expiresAt,
    Array.from(hexToBytes(args.signature, { size: 64 })),
  ] as const

/** What `CrispAztec` and `CrispAztecVotes` share: the session, the round-id mapping, log reads and sending a transaction. */
export abstract class RoundClient {
  constructor(
    readonly session: AztecSession,
    /** The Interfold whose e3Ids the contract serves; the contract itself only knows their low 96 bits. */
    readonly interfold: Address,
  ) {}

  abstract get address(): AztecAddress

  /** The id the contract keys a round by. */
  roundIdFor(e3Id: bigint): bigint {
    if (e3IdOf(this.interfold, roundIdOf(e3Id)) !== e3Id) throw new Error(`e3Id ${e3Id} does not belong to Interfold ${this.interfold}`)

    return roundIdOf(e3Id)
  }

  protected async view<T>(call: ContractFunctionInteraction): Promise<T> {
    const { result } = await call.simulate({ from: this.session.address })

    return result as T
  }

  /** Public logs of one kind this contract emitted, oldest first. */
  logs<K extends Parameters<typeof readLogs>[2]>(kind: K, options: ReadLogsOptions & { e3Id?: bigint } = {}) {
    return readLogs(this.session.node, this.address, kind, this.interfold, options)
  }

  /** The committee key commitment from the KEY message; `undefined` until `publish_key` has consumed it. */
  async getCommitteeKey(e3Id: bigint): Promise<Hex | undefined> {
    const [published] = await this.logs('KeyPublished', { e3Id })

    return published?.committeePublicKey
  }

  async isClosed(e3Id: bigint): Promise<boolean> {
    return (await this.logs('RoundClosed', { e3Id })).length > 0
  }

  /** The census of a round, rebuilt from its MEMBER_REGISTERED logs. */
  async getCensus(e3Id: bigint): Promise<Census> {
    return censusFromLogs(await this.logs('MemberRegistered', { e3Id }))
  }

  protected async send(call: ContractFunctionInteraction, capsules?: Capsule[]): Promise<SentTx> {
    const { receipt } = await call.send({ from: this.session.address, fee: this.session.fee, capsules })

    return { txHash: receipt.txHash.toString(), blockNumber: receipt.blockNumber === undefined ? undefined : Number(receipt.blockNumber) }
  }

  /** The leaf index `consume_l1_to_l2_message` needs, once an L2 block has included the Inbox message. */
  protected async messageLeafIndex(message: L1ToL2Message): Promise<bigint> {
    const leaf = Fr.fromHexString(message.leaf)
    if (!(await waitForL1ToL2MessageReady(this.session.node, leaf, { timeoutSeconds: MESSAGE_TIMEOUT_SECONDS }))) {
      throw new Error(`The L1→L2 message ${message.leaf} was not included in an L2 block in time`)
    }
    // Blocks insert Inbox messages in order into consecutive leaves, so the node's index of the message is its leaf index.
    const index = await this.session.node.getL1ToL2MessageIndex(leaf)
    if (index === undefined) throw new Error(`The node does not know the L1→L2 message ${message.leaf}`)

    return index
  }
}
