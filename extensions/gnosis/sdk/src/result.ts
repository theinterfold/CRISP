// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import type { Address, PublicClient } from 'viem'

import { crispGnosisProgramAbi } from './abi/CRISPGnosisProgram'
import { crispGnosisVotingAbi } from './abi/CrispGnosisVoting'
import { crispGovernanceModuleAbi } from './abi/CrispGovernanceModule'
import { E3_STAGE } from './constants'
import { delayAbi, getDelayState } from './delay'
import { interfoldAbi } from './interfold'
import { roundIdOf } from './messages'

/** `CrispGnosisVoting.roundOf`: the round as the ROUND, KEY and ballots left it on Chiado. `inputEnd == 0`: it is not open there yet. */
export const getRound = (chiado: PublicClient, voting: Address, roundId: bigint) =>
  chiado.readContract({ address: voting, abi: crispGnosisVotingAbi, functionName: 'roundOf', args: [roundId] })

/** `CrispGnosisVoting.resultOf`: the tally per option (For, Against, Abstain), in ballot units, once the RESULT arrived. */
export const getResult = (chiado: PublicClient, voting: Address, roundId: bigint) =>
  chiado.readContract({ address: voting, abi: crispGnosisVotingAbi, functionName: 'resultOf', args: [roundId] })

/** A tally in ballot units as token wei: each unit is `divisor` wei of voting power. */
export const tallyInTokens = (tally: readonly bigint[], divisor: bigint): bigint[] => tally.map((units) => units * divisor)

/** Where a proposal stands, the way the app shows it. */
export type ProposalPhase =
  | 'Requested'
  | 'RoundOpen'
  | 'KeyReady'
  | 'Voting'
  | 'Closed'
  | 'Computing'
  | 'ResultDelivered'
  | 'Queued'
  | 'Executed'
  | 'Failed'

/**
 * Merge Interfold's stage of the E3 (Sepolia), the round and result on Chiado and, when `module` is given, the module's
 * and the Delay's state into one status.
 *
 * - `Requested`: Sepolia accepted the request, the ROUND message has not reached Chiado.
 * - `RoundOpen`: open on Chiado, waiting for the committee key. `KeyReady`: key there, the window has not started.
 * - `Voting` / `Closed`: inside / after the window, until the round is closed. `Computing`: closed; the root, the
 *   computation and the decryption are under way. `ResultDelivered`: the tally is on Chiado.
 * - `Queued`: the module put the batch in the Delay. `Executed`: the Delay ran it. `Failed`: Interfold failed the E3.
 */
export const getProposalStatus = async (args: {
  sepolia: PublicClient
  chiado: PublicClient
  interfold: Address
  program: Address
  voting: Address
  /** `CrispGovernanceModule`; without it a proposal ends at `ResultDelivered`. */
  module?: Address
  e3Id: bigint
}) => {
  const { sepolia, chiado, interfold, program, voting, module, e3Id } = args
  const roundId = roundIdOf(e3Id)
  const [stage, l1Round, resultRelayed, round, result, latest] = await Promise.all([
    sepolia.readContract({ address: interfold, abi: interfoldAbi, functionName: 'getE3Stage', args: [e3Id] }),
    sepolia.readContract({ address: program, abi: crispGnosisProgramAbi, functionName: 'getRound', args: [e3Id] }),
    sepolia.readContract({ address: program, abi: crispGnosisProgramAbi, functionName: 'resultRelayed', args: [e3Id] }),
    getRound(chiado, voting, roundId),
    getResult(chiado, voting, roundId),
    chiado.getBlock({ blockTag: 'latest' }),
  ])
  const now = latest.timestamp
  const queued = module ? await isQueued(chiado, module, roundId) : false
  const executed = queued ? await hasRunFromDelay(chiado, module!, roundId) : false

  let phase: ProposalPhase
  if (stage === E3_STAGE.Failed) phase = 'Failed'
  else if (executed) phase = 'Executed'
  else if (queued) phase = 'Queued'
  else if (result.resolved) phase = 'ResultDelivered'
  else if (round.closed) phase = 'Computing'
  else if (round.inputEnd === 0n) phase = 'Requested'
  else if (round.committeeKey === `0x${'0'.repeat(64)}`) phase = 'RoundOpen'
  else if (now < round.inputStart) phase = 'KeyReady'
  else if (now < round.inputEnd) phase = 'Voting'
  else phase = 'Closed'

  return { phase, stage, round, result, l1Round, resultRelayed, now }
}

const isQueued = (chiado: PublicClient, module: Address, roundId: bigint): Promise<boolean> =>
  chiado.readContract({ address: module, abi: crispGovernanceModuleAbi, functionName: 'executed', args: [roundId] })

/** Whether the Delay already ran the batch the module queued for `roundId`: its queue entry is behind the Delay's `txNonce`. */
const hasRunFromDelay = async (chiado: PublicClient, module: Address, roundId: bigint): Promise<boolean> => {
  const delay = await chiado.readContract({ address: module, abi: crispGovernanceModuleAbi, functionName: 'target' })
  const [queuedLog] = await chiado.getContractEvents({
    address: module,
    abi: crispGovernanceModuleAbi,
    eventName: 'ProposalQueued',
    args: { roundId },
    fromBlock: 0n,
  })
  if (!queuedLog) return false
  const entries = await chiado.getContractEvents({
    address: delay,
    abi: delayAbi,
    eventName: 'TransactionAdded',
    fromBlock: queuedLog.blockNumber,
    toBlock: queuedLog.blockNumber,
  })
  const added = entries.find((entry) => entry.transactionHash === queuedLog.transactionHash)
  if (!added) return false
  const { txNonce } = await getDelayState(chiado, delay)

  return txNonce > added.args.queueNonce!
}
