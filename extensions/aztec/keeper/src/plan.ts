// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

/** Interfold's `E3Stage` values the keeper acts on (see `E3_STAGE` in @crisp-e3/aztec). */
const KEY_PUBLISHED = 3
const FAILED = 6

/** Everything the keeper needs to know about one round, read from L1 and Aztec. */
export type RoundState = {
  e3Id: bigint
  /** Interfold's stage of the E3 on L1. */
  stage: number
  /** L1 program: the committee key has been sent to Aztec / the input root has been accepted. */
  l1KeyRelayed: boolean
  l1RootSubmitted: boolean
  /** Aztec contract: the ROUND and KEY messages were consumed, and the round was closed. */
  l2Opened: boolean
  l2KeyPublished: boolean
  l2Closed: boolean
  /** The voters register on L1 (the round has a `ZKPassportRegistrar`): the keeper carries their MEMBER messages to Aztec. */
  l1Registration: boolean
  /** MEMBER messages the program sent that Aztec has not consumed (only counted while registration is open on Aztec). */
  pendingMembers: number
  /** Unix seconds: the end of the round's input window, and the timestamp of the latest Aztec block. */
  inputEnd: bigint
  l2Now: bigint
}

export type Action = 'openRound' | 'relayKey' | 'publishKey' | 'addMembers' | 'closeRound' | 'submitRoot'

/** A round nothing more can be done for: its root is on L1, or Interfold failed it. */
export const isFinished = (round: RoundState): boolean => round.l1RootSubmitted || round.stage === FAILED

/**
 * The steps that are due for a round, in the order to run them. Each is derived from on-chain state alone, so a
 * keeper that restarts, or runs next to another one, repeats nothing that is already done.
 */
export const dueActions = (round: RoundState): Action[] => {
  if (isFinished(round)) return []

  const actions: Action[] = []
  if (!round.l2Opened) actions.push('openRound')
  if (!round.l1KeyRelayed && round.stage === KEY_PUBLISHED) actions.push('relayKey')
  if (round.l1KeyRelayed && !round.l2KeyPublished) actions.push('publishKey')
  if (round.l1Registration && round.l2Opened && !round.l2Closed && round.l2Now < round.inputEnd && round.pendingMembers > 0)
    actions.push('addMembers')
  if (round.l2Opened && !round.l2Closed && round.l2Now >= round.inputEnd) actions.push('closeRound')
  if (round.l2Closed) actions.push('submitRoot')

  return actions
}

/**
 * The MEMBER messages of a round Aztec has not consumed: those sent on L1 whose slot has no `MEMBER_REGISTERED` log yet. A slot
 * the registrar sent twice (two documents, one slot) registers once and its second message can never be consumed, so only the
 * first of a slot is pending.
 */
export const pendingMembers = <T extends { slot: string }>(sent: readonly T[], registeredSlots: Iterable<string>): T[] => {
  const seen = new Set(registeredSlots)

  return sent.filter(({ slot }) => !seen.has(slot) && (seen.add(slot), true))
}
