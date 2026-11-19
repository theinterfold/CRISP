// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { describe, expect, it } from 'vitest'

import { delayAction, dueActions, type RoundState } from '../src/plan'

const KEY_PUBLISHED = 3
const COMPLETE = 5
const FAILED = 6
const base: RoundState = {
  e3Id: 1n,
  stage: 2,
  keyRelayed: false,
  rootDelivered: false,
  resultRelayed: false,
  opened: true,
  closed: false,
  resultResolved: false,
  numInputs: 0n,
  inputEnd: 1_000n,
  now: 500n,
}

describe('dueActions', () => {
  it('waits for the committee key', () => {
    expect(dueActions(base)).toEqual([])
  })

  it('relays the key once Interfold has published it, and only until the program has sent it', () => {
    expect(dueActions({ ...base, stage: KEY_PUBLISHED })).toEqual(['relayKey'])
    expect(dueActions({ ...base, stage: KEY_PUBLISHED, keyRelayed: true })).toEqual([])
  })

  it('closes a round only after its input window, with ballots, and only once', () => {
    const live = { ...base, stage: KEY_PUBLISHED, keyRelayed: true, numInputs: 3n }
    expect(dueActions({ ...live, now: 999n })).toEqual([])
    expect(dueActions({ ...live, now: 1_000n })).toEqual(['closeRound'])
    expect(dueActions({ ...live, now: 1_000n, numInputs: 0n })).toEqual([])
    expect(dueActions({ ...live, now: 1_000n, closed: true })).toEqual(['deliverRoot'])
  })

  it('does not relay the key to a round Chiado has not opened', () => {
    expect(dueActions({ ...base, stage: KEY_PUBLISHED, opened: false })).toEqual([])
  })

  it('does not close a round Chiado has not opened', () => {
    expect(dueActions({ ...base, stage: KEY_PUBLISHED, keyRelayed: true, opened: false, now: 2_000n, numInputs: 1n })).toEqual([])
  })

  it('delivers the root until the program has accepted it', () => {
    const closed = { ...base, stage: KEY_PUBLISHED, keyRelayed: true, closed: true, numInputs: 3n, now: 2_000n }
    expect(dueActions(closed)).toEqual(['deliverRoot'])
    expect(dueActions({ ...closed, rootDelivered: true })).toEqual([])
  })

  it('relays the result once Interfold completed the round', () => {
    const done = { ...base, stage: COMPLETE, keyRelayed: true, closed: true, rootDelivered: true }
    expect(dueActions(done)).toEqual(['relayResult'])
    expect(dueActions({ ...done, resultRelayed: true })).toEqual([])
  })

  it('does nothing for a round whose result arrived, or that Interfold failed', () => {
    const done = { ...base, stage: COMPLETE, keyRelayed: true, closed: true, rootDelivered: true, resultRelayed: true }
    expect(dueActions({ ...done, resultResolved: true })).toEqual([])
    expect(dueActions({ ...base, stage: FAILED, keyRelayed: false })).toEqual([])
  })

  it('resumes a restarted keeper from whatever is already on chain', () => {
    const state = { ...base, stage: KEY_PUBLISHED, now: 1_500n, numInputs: 2n, closed: false }
    expect(dueActions(state)).toEqual(['relayKey', 'closeRound'])
  })

  describe('with the governance module', () => {
    const resolved = { ...base, stage: COMPLETE, keyRelayed: true, closed: true, rootDelivered: true, resultRelayed: true, resultResolved: true }

    it('keeps a round open until its proposal is executed', () => {
      expect(dueActions({ ...resolved, proposal: 'pending' })).toEqual([])
      expect(dueActions({ ...resolved, proposal: 'executable' })).toEqual(['executeProposal'])
      expect(dueActions({ ...resolved, proposal: 'executed' })).toEqual([])
    })

    it('stops on a result that can never pass', () => {
      expect(dueActions({ ...resolved, proposal: 'rejected' })).toEqual([])
    })
  })
})

describe('delayAction', () => {
  const queued = { queued: true, readyAt: 1_000n, expiresAt: 5_000n, now: 1_000n }

  it('runs the next entry from the end of its cooldown until it expires', () => {
    expect(delayAction({ ...queued, now: 999n })).toBeUndefined()
    expect(delayAction(queued)).toBe('executeNextTx')
    expect(delayAction({ ...queued, now: 5_000n })).toBe('executeNextTx')
  })

  it('skips an expired head', () => {
    expect(delayAction({ ...queued, now: 5_001n })).toBe('skipExpired')
  })

  it('never expires without an expiration, and does nothing for an empty queue', () => {
    expect(delayAction({ ...queued, expiresAt: undefined, now: 10n ** 12n })).toBe('executeNextTx')
    expect(delayAction({ ...queued, queued: false })).toBeUndefined()
  })
})
