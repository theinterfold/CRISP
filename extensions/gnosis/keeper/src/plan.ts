// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

/** Interfold's `E3Stage` values the keeper acts on (see `E3_STAGE` in @crisp-e3/gnosis). */
const KEY_PUBLISHED = 3
const COMPLETE = 5
const FAILED = 6

/**
 * Where the governance module stands for a round, when the keeper runs one:
 * `pending` the result has not arrived; `executable` `executeProposal` would queue the batch; `executed` it did;
 * `rejected` the result can never pass (quorum, approval or expiry).
 */
export type ProposalState = 'pending' | 'executable' | 'executed' | 'rejected'

/** Everything the keeper needs to know about one round, read from Sepolia and Chiado. */
export type RoundState = {
  e3Id: bigint
  /** Interfold's stage of the E3 on Sepolia. */
  stage: number
  /** Sepolia program: the KEY message was sent, ROOT was accepted, RESULT was sent. */
  keyRelayed: boolean
  rootDelivered: boolean
  resultRelayed: boolean
  /** Chiado voting contract: the ROUND message arrived, the round was closed, the RESULT arrived. */
  opened: boolean
  closed: boolean
  resultResolved: boolean
  /** Ballots accepted so far, and the end of the input window; `now` is the timestamp of Chiado's latest block. */
  numInputs: bigint
  inputEnd: bigint
  now: bigint
  /** `undefined` when the keeper does not run the module. */
  proposal?: ProposalState
}

export type Action = 'relayKey' | 'closeRound' | 'deliverRoot' | 'relayResult' | 'executeProposal'

/** A round nothing more can be done for: Interfold failed it, its result arrived (or its batch was queued), or it can not pass. */
export const isFinished = (round: RoundState): boolean => {
  if (round.stage === FAILED) return true
  if (round.proposal === undefined) return round.resultResolved

  return round.proposal === 'executed' || round.proposal === 'rejected'
}

/**
 * The steps that are due for a round, in the order to run them. Each is derived from on-chain state alone, so a
 * keeper that restarts, or runs next to another one, repeats nothing that is already done.
 */
export const dueActions = (round: RoundState): Action[] => {
  if (isFinished(round)) return []

  const actions: Action[] = []
  // The program's KEY would revert on Chiado while the round is not open there (the ROUND message is still in flight).
  if (!round.keyRelayed && round.opened && round.stage === KEY_PUBLISHED) actions.push('relayKey')
  if (round.opened && !round.closed && round.now >= round.inputEnd && round.numInputs > 0n) actions.push('closeRound')
  if (round.closed && !round.rootDelivered && round.stage === KEY_PUBLISHED) actions.push('deliverRoot')
  if (round.stage === COMPLETE && !round.resultRelayed) actions.push('relayResult')
  if (round.proposal === 'executable') actions.push('executeProposal')

  return actions
}

/** The Delay modifier's queue as the keeper sees it. */
export type DelayObservation = {
  /** The next entry to run exists (`txNonce < queueNonce`). */
  queued: boolean
  /** Unix seconds: the entry's cooldown ends, and it expires (`undefined`: never). */
  readyAt: bigint
  expiresAt?: bigint
  now: bigint
}

/**
 * What the Delay's next entry calls for: `executeNextTx` from the end of its cooldown until it expires, then
 * `skipExpired`, which an expired head needs, or every entry behind it is stuck.
 */
export const delayAction = (delay: DelayObservation): 'executeNextTx' | 'skipExpired' | undefined => {
  if (!delay.queued || delay.now < delay.readyAt) return undefined

  return delay.expiresAt !== undefined && delay.now > delay.expiresAt ? 'skipExpired' : 'executeNextTx'
}
