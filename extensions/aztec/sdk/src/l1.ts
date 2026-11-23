// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { parseAbi, type Address, type Hex, type PublicClient, type WalletClient } from 'viem'

import { type RoundConfig, type VotesRoundConfig, roundContent, roundIdOf, votesRoundContent } from './messages'
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

/** Relay the committee key to Aztec. Permissionless; the key is read from Interfold. */
export const publishCommitteeKey = async (wallet: WalletClient, client: PublicClient, program: Address, e3Id: bigint): Promise<Hex> => {
  const { request } = await client.simulateContract({
    address: program,
    abi: programAbi,
    functionName: 'publishCommitteeKey',
    args: [e3Id],
    account: wallet.account,
  })

  return wallet.writeContract(request)
}

/** The Outbox witness of the ROOT message, as `getL2ToL1MembershipWitness` reports it. */
export type RootWitness = { epoch: bigint; numCheckpointsInEpoch: bigint; leafIndex: bigint; path: Hex[] }

/** Deliver the root the L2 contract reported to the L1 program. Permissionless; the Outbox authenticates the content. */
export const submitInputRoot = async (
  wallet: WalletClient,
  client: PublicClient,
  program: Address,
  args: { e3Id: bigint; inputRoot: bigint; numInputs: bigint; witness: RootWitness },
): Promise<Hex> => {
  const { witness } = args
  const { request } = await client.simulateContract({
    address: program,
    abi: programAbi,
    functionName: 'submitInputRoot',
    args: [args.e3Id, args.inputRoot, args.numInputs, witness.epoch, witness.numCheckpointsInEpoch, witness.leafIndex, witness.path],
    account: wallet.account,
  })

  return wallet.writeContract(request)
}

// ---------------------------------------------------------------------------------------------------------
// The votes program (`CRISPAztecVotesProgram`): token-weighted rounds, weights bridged per slot by `enroll`
// ---------------------------------------------------------------------------------------------------------

/** The part of `CRISPAztecVotesProgram` this package calls or reads, besides {@link programAbi}. */
export const votesProgramAbi = parseAbi([
  'function tokenOf(uint256 e3Id) view returns (address)',
  'function snapshotOf(uint256 e3Id) view returns (uint48)',
  'function minVotingPowerOf(uint256 e3Id) view returns (uint256)',
  'function votingPowerDivisorOf(uint256 e3Id) view returns (uint256)',
  'function weightOf(uint256 e3Id, address slot) view returns (uint256)',
  'function isEnrolled(uint256 e3Id, address slot) view returns (bool)',
  'function enroll(uint256 e3Id, address[] slots) returns (uint256 enrolled)',
  'event Enrolled(uint256 indexed e3Id, address indexed slot, uint256 weight, bytes32 content, uint256 index)',
])

/** The L1 record of a votes round: the ROUND message plus the weight rules the program recorded. */
export type VotesRound = VotesRoundConfig & {
  e3Id: bigint
  token: Address
  /** The block (or timestamp) `getPastVotes` is read at. */
  snapshot: bigint
  /** A slot with fewer raw votes than this cannot enroll. */
  minVotingPower: bigint
  /** A slot's weight is `getPastVotes / divisor`. */
  divisor: bigint
}

/**
 * Rebuild the ROUND configuration the votes program sent for `e3Id` from L1 state, with its weight rules, and check it against the
 * first message the program sent. A keeper opens the round on L2 from this.
 */
export const getVotesRound = async (client: PublicClient, program: Address, e3Id: bigint): Promise<VotesRound> => {
  const read = <T extends (typeof votesProgramAbi)[number]['name']>(functionName: T) =>
    client.readContract({ address: program, abi: votesProgramAbi, functionName, args: [e3Id] } as never) as Promise<never>
  const [interfold, round, token, snapshot, minVotingPower, divisor] = await Promise.all([
    client.readContract({ address: program, abi: programAbi, functionName: 'interfold' }),
    getL1Round(client, program, e3Id),
    read('tokenOf') as Promise<Address>,
    read('snapshotOf') as Promise<number>,
    read('minVotingPowerOf') as Promise<bigint>,
    read('votingPowerDivisorOf') as Promise<bigint>,
  ])
  const e3 = await client.readContract({ address: interfold, abi: interfoldAbi, functionName: 'getE3', args: [e3Id] })
  const config: VotesRound = {
    e3Id,
    roundId: roundIdOf(e3Id),
    numOptions: round.numOptions,
    inputStart: e3.inputWindow[0],
    inputEnd: e3.inputWindow[1],
    inputLimit: round.inputLimit,
    token,
    snapshot: BigInt(snapshot),
    minVotingPower,
    divisor,
  }

  const [first] = await getSentMessages(client, program, e3Id)
  if (first && BigInt(first.content) !== votesRoundContent(config)) {
    throw new Error(`Round ${e3Id}: the configuration rebuilt from L1 does not hash to the content the program sent`)
  }

  return config
}

/** The weight `slot` carries in the round (`getPastVotes / divisor`, 0 below the floor). */
export const weightOf = (client: PublicClient, program: Address, e3Id: bigint, slot: Address): Promise<bigint> =>
  client.readContract({ address: program, abi: votesProgramAbi, functionName: 'weightOf', args: [e3Id, slot] })

/** Whether `enroll` already bridged `slot`'s weight on L1 (its Aztec side may still be pending). */
export const isEnrolled = (client: PublicClient, program: Address, e3Id: bigint, slot: Address): Promise<boolean> =>
  client.readContract({ address: program, abi: votesProgramAbi, functionName: 'isEnrolled', args: [e3Id, slot] })

/** An ENROLL message the program sent: what `CrispAztecVotes.enroll` consumes. */
export type EnrolledMessage = { slot: Address; weight: bigint; message: L1ToL2Message }

/** Every `Enrolled` event of a round (optionally of some slots), with the Inbox message each sent, oldest first. */
export const getEnrolledMessages = async (
  client: PublicClient,
  program: Address,
  e3Id: bigint,
  options: { slots?: readonly Address[]; fromBlock?: bigint } = {},
): Promise<EnrolledMessage[]> => {
  const fromBlock = options.fromBlock ?? 0n
  const [events, sent] = await Promise.all([
    client.getContractEvents({ address: program, abi: votesProgramAbi, eventName: 'Enrolled', args: { e3Id }, fromBlock }),
    getSentMessages(client, program, e3Id, fromBlock),
  ])
  const wanted = options.slots && new Set(options.slots.map((slot) => slot.toLowerCase()))

  return events
    .filter(({ args }) => !wanted || wanted.has((args.slot as Address).toLowerCase()))
    .map(({ args }) => {
      const message = sent.find((candidate) => candidate.index === args.index && BigInt(candidate.content) === BigInt(args.content as Hex))
      if (!message) throw new Error(`The program emitted Enrolled for ${args.slot} without a matching L1ToL2MessageSent`)

      return { slot: args.slot as Address, weight: args.weight as bigint, message }
    })
}

/** Bridge the weights of `slots` to Aztec. Permissionless: a voter may call it directly when the server's relay is unavailable. */
export const enrollSlots = async (
  wallet: WalletClient,
  client: PublicClient,
  program: Address,
  e3Id: bigint,
  slots: readonly Address[],
): Promise<Hex> => {
  const { request } = await client.simulateContract({
    address: program,
    abi: votesProgramAbi,
    functionName: 'enroll',
    args: [e3Id, slots],
    account: wallet.account,
  })

  return wallet.writeContract(request)
}
