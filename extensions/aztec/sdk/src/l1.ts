// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { parseAbi, type Address, type Hex, type PublicClient, type WalletClient } from 'viem'

import { type RoundConfig, type VotesRoundConfig, roundContent, roundIdOf } from './messages'
import { decodeCustomParams, type RoundRules } from './rules'

/** The part of `CRISPAztecProgram` and `CRISPRemoteProgram` this package calls or reads. */
export const programAbi = parseAbi([
  'function interfold() view returns (address)',
  'function l2Program() view returns (bytes32)',
  'function rollupVersion() view returns (uint256)',
  'function scopeHashOf(uint256 e3Id) view returns (uint256)',
  'function getRound(uint256 e3Id) view returns ((bytes32 paramsHash, uint256 numOptions, uint256 inputLimit, bool keyRelayed, bool rootSubmitted, uint256 inputRoot, uint256 numInputs))',
  'function publishCommitteeKey(uint256 e3Id)',
  'function submitInputRoot(uint256 e3Id, uint256 inputRoot, uint256 numInputs, uint256 epoch, uint256 numCheckpointsInEpoch, uint256 leafIndex, bytes32[] path)',
  'event RoundConfigSent(uint256 indexed e3Id, bytes32 content)',
  'event CommitteeKeyRelayed(uint256 indexed e3Id, bytes32 committeePublicKey)',
  'event InputRootSubmitted(uint256 indexed e3Id, uint256 inputRoot, uint256 numInputs)',
  'event L1ToL2MessageSent(uint256 indexed e3Id, bytes32 content, bytes32 leaf, uint256 index)',
])

/** The part of the Interfold controller this package reads. */
export const interfoldAbi = parseAbi([
  'function getE3Stage(uint256 e3Id) view returns (uint8)',
  'function getE3(uint256 e3Id) view returns ((uint256 seed, uint8 committeeSize, uint256 requestBlock, uint256[2] inputWindow, bytes32 encryptionSchemeId, address e3Program, uint8 paramSet, bytes customParams, address decryptionVerifier, address pkVerifier, bytes32 committeePublicKey, bytes32 ciphertextOutput, bytes plaintextOutput, address requester, bytes32 ciphertextCommitment))',
])

/** `IInterfold.E3Stage`. */
export const E3_STAGE = {
  None: 0,
  Requested: 1,
  CommitteeFinalized: 2,
  KeyPublished: 3,
  CiphertextReady: 4,
  Complete: 5,
  Failed: 6,
} as const

export type L1ToL2Message = { content: Hex; leaf: Hex; index: bigint }

/** `CRISPRemoteProgram.Round`, the L1 record of a round. */
export type L1Round = {
  numOptions: bigint
  inputLimit: bigint
  keyRelayed: boolean
  rootSubmitted: boolean
  inputRoot: bigint
  numInputs: bigint
}

export const getL1Round = async (client: PublicClient, program: Address, e3Id: bigint): Promise<L1Round> => {
  const round = await client.readContract({ address: program, abi: programAbi, functionName: 'getRound', args: [e3Id] })

  return { ...round }
}

/**
 * Rebuild the ROUND configuration the program sent for `e3Id` (the full Interfold id; the message carries its `roundId`) from L1 state, and check it against the content the
 * program announced. A keeper opens the round on L2 from this, so a mismatch means L1 and this package disagree
 * on the message layout, and the L2 contract would refuse the consumption anyway.
 */
export const getRoundConfig = async (
  client: PublicClient,
  program: Address,
  e3Id: bigint,
): Promise<RoundConfig & { e3Id: bigint; rules: RoundRules }> => {
  const [interfold, scopeHash, round] = await Promise.all([
    client.readContract({ address: program, abi: programAbi, functionName: 'interfold' }),
    client.readContract({ address: program, abi: programAbi, functionName: 'scopeHashOf', args: [e3Id] }),
    getL1Round(client, program, e3Id),
  ])
  const e3 = await client.readContract({ address: interfold, abi: interfoldAbi, functionName: 'getE3', args: [e3Id] })
  const rules = decodeCustomParams(e3.customParams)
  const config: RoundConfig & { e3Id: bigint; rules: RoundRules } = {
    e3Id,
    roundId: roundIdOf(e3Id),
    numOptions: rules.numOptions,
    credits: rules.credits,
    inputStart: e3.inputWindow[0],
    inputEnd: e3.inputWindow[1],
    inputLimit: round.inputLimit,
    scopeHash,
    minAge: rules.minAge,
    allowMockDocuments: rules.allowMockDocuments,
    nationalityMode: rules.nationalityMode,
    nationalityCommitment: rules.nationalityCommitment,
    rules,
  }

  const [sent] = await client.getContractEvents({
    address: program,
    abi: programAbi,
    eventName: 'RoundConfigSent',
    args: { e3Id },
    fromBlock: 0n,
  })
  if (sent && BigInt(sent.args.content as Hex) !== roundContent(config)) {
    throw new Error(`Round ${e3Id}: the configuration rebuilt from L1 does not hash to the content the program sent`)
  }

  return config
}

/** Every L1→L2 message the program sent for a round, oldest first (the ROUND message, then the KEY message). */
export const getSentMessages = async (client: PublicClient, program: Address, e3Id: bigint, fromBlock = 0n): Promise<L1ToL2Message[]> => {
  const logs = await client.getContractEvents({
    address: program,
    abi: programAbi,
    eventName: 'L1ToL2MessageSent',
    args: { e3Id },
    fromBlock,
  })

  return logs.map(({ args }) => ({ content: args.content as Hex, leaf: args.leaf as Hex, index: args.index as bigint }))
}

/**
 * The gas limit for an estimate: the estimate plus a quarter. These calls write to Aztec's Inbox or Outbox, whose cost
 * depends on tree state that can move between the estimate and inclusion. A limit of exactly the estimate can then run
 * a sub-call out of gas. Unused gas is refunded.
 */
const withHeadroom = (estimate: bigint): bigint => estimate + estimate / 4n

/** Relay the committee key to Aztec. Permissionless; the key is read from Interfold. */
export const publishCommitteeKey = async (wallet: WalletClient, client: PublicClient, program: Address, e3Id: bigint): Promise<Hex> => {
  const call = { address: program, abi: programAbi, functionName: 'publishCommitteeKey', args: [e3Id], account: wallet.account } as const
  const { request } = await client.simulateContract(call)

  return wallet.writeContract({ ...request, gas: withHeadroom(await client.estimateContractGas(call)) })
}

/** The Outbox witness of the ROOT message, as `getL2ToL1MembershipWitness` reports it. */
export type RootWitness = { epoch: bigint; numCheckpointsInEpoch: bigint; leafIndex: bigint; path: Hex[] }

/** Deliver the root the L2 contract reported to the L1 program. Permissionless; the Outbox authenticates the content. */
export const submitInputRoot = async (
  wallet: WalletClient,
  client: PublicClient,
  program: Address,
): Promise<Hex> => {
  const { witness } = args
  const call = {
    address: program,
    abi: programAbi,
    functionName: 'submitInputRoot',
    args: [args.e3Id, args.inputRoot, args.numInputs, witness.epoch, witness.numCheckpointsInEpoch, witness.leafIndex, witness.path],
    account: wallet.account,
  } as const
  const { request } = await client.simulateContract(call)

  return wallet.writeContract({ ...request, gas: withHeadroom(await client.estimateContractGas(call)) })
}

// ---------------------------------------------------------------------------------------------------------
// The votes program (`CRISPAztecVotesProgram`): token-weighted rounds, weights bridged per slot by `enroll`
// ---------------------------------------------------------------------------------------------------------

/** The part of `CRISPAztecVotesProgram` this package reads, besides {@link programAbi}. */
export const votesProgramAbi = parseAbi([
  'event Enrolled(uint256 indexed e3Id, address indexed slot, uint256 weight, bytes32 leaf)',
])

/** Rebuild the ROUND configuration the votes program sent for `e3Id` from L1 state. A keeper opens the round on L2 from this. */
export const getVotesRound = async (client: PublicClient, program: Address, e3Id: bigint): Promise<VotesRoundConfig> => {
  const interfold = await client.readContract({ address: program, abi: programAbi, functionName: 'interfold' })
  const [round, e3] = await Promise.all([
    getL1Round(client, program, e3Id),
    client.readContract({ address: interfold, abi: interfoldAbi, functionName: 'getE3', args: [e3Id] }),
  ])

  return {
    roundId: roundIdOf(e3Id),
    numOptions: round.numOptions,
    inputStart: e3.inputWindow[0],
    inputEnd: e3.inputWindow[1],
    inputLimit: round.inputLimit,
  }
}

/** An ENROLL message the program sent. `leaf` is the Inbox leaf that `CrispAztecVotes.enroll` consumes. */
export type EnrolledMessage = { slot: Address; weight: bigint; leaf: Hex }

/** Every `Enrolled` event of a round (optionally of some slots), oldest first. */
export const getEnrolledMessages = async (
  client: PublicClient,
  program: Address,
  e3Id: bigint,
  options: { slots?: readonly Address[]; fromBlock?: bigint } = {},
): Promise<EnrolledMessage[]> => {
  const events = await client.getContractEvents({
    address: program,
    abi: votesProgramAbi,
    eventName: 'Enrolled',
    args: { e3Id, slot: options.slots && [...options.slots] },
    fromBlock: options.fromBlock ?? 0n,
  })

  return events.map(({ args }) => ({ slot: args.slot as Address, weight: args.weight as bigint, leaf: args.leaf as Hex }))
}
