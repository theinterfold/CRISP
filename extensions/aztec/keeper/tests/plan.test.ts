// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { describe, expect, it } from 'vitest'

import { dueActions, pendingMembers, type RoundState } from '../src/plan'

const KEY_PUBLISHED = 3
const base: RoundState = {
  e3Id: 1n,
  stage: 2,
  l1KeyRelayed: false,
  l1RootSubmitted: false,
  l2Opened: false,
  l2KeyPublished: false,
  l2Closed: false,
  l1Registration: false,
  pendingMembers: 0,
  inputEnd: 1_000n,
  l2Now: 500n,
}

describe('dueActions', () => {
  it('opens a round that Aztec does not know yet', () => {
    expect(dueActions(base)).toEqual(['openRound'])
  })

  it('relays the key once Interfold has published it, and only then', () => {
    expect(dueActions({ ...base, l2Opened: true, stage: 2 })).toEqual([])
    expect(dueActions({ ...base, l2Opened: true, stage: KEY_PUBLISHED })).toEqual(['relayKey'])
  })

  it('publishes a relayed key on Aztec until it is there', () => {
    const relayed = { ...base, l2Opened: true, stage: KEY_PUBLISHED, l1KeyRelayed: true }
    expect(dueActions(relayed)).toEqual(['publishKey'])
    expect(dueActions({ ...relayed, l2KeyPublished: true })).toEqual([])
  })

  it('closes a round only after its input window, and only once', () => {
    const live = { ...base, l2Opened: true, l1KeyRelayed: true, l2KeyPublished: true }
    expect(dueActions({ ...live, l2Now: 999n })).toEqual([])
    expect(dueActions({ ...live, l2Now: 1_000n })).toEqual(['closeRound'])
    expect(dueActions({ ...live, l2Now: 2_000n, l2Closed: true })).toEqual(['submitRoot'])
  })

  it('does nothing for a round whose root is on L1 or that Interfold failed', () => {
    const closed = { ...base, l2Opened: true, l2Closed: true, l1KeyRelayed: true, l2KeyPublished: true, l2Now: 2_000n }
    expect(dueActions({ ...closed, l1RootSubmitted: true })).toEqual([])
    expect(dueActions({ ...base, stage: 6 })).toEqual([])
  })

  it('resumes a restarted keeper from whatever is already on chain', () => {
    const afterOpenAndRelay = { ...base, l2Opened: true, stage: KEY_PUBLISHED, l1KeyRelayed: true, l2Now: 1_500n }
    expect(dueActions(afterOpenAndRelay)).toEqual(['publishKey', 'closeRound'])
  })
})

describe('members registered on L1', () => {
  const live = { ...base, l2Opened: true, l1Registration: true, l1KeyRelayed: true, l2KeyPublished: true, pendingMembers: 2 }

  it('carries pending MEMBER messages to Aztec while registration is open', () => {
    expect(dueActions(live)).toEqual(['addMembers'])
    expect(dueActions({ ...live, pendingMembers: 0 })).toEqual([])
  })

  it('waits for the round to be open on Aztec', () => {
    expect(dueActions({ ...live, l2Opened: false })).toEqual(['openRound'])
  })

  it('stops once registration closed: the window is over or the round is closed', () => {
    expect(dueActions({ ...live, l2Now: 1_000n })).toEqual(['closeRound'])
    expect(dueActions({ ...live, l2Closed: true })).toEqual(['submitRoot'])
  })

  it('never carries members of a round that registers on Aztec', () => {
    expect(dueActions({ ...live, l1Registration: false })).toEqual([])
  })

  it('carries members before closing, in the same pass that notices an old window', () => {
    expect(dueActions({ ...live, l1KeyRelayed: false, stage: KEY_PUBLISHED })).toEqual(['relayKey', 'addMembers'])
  })
})

describe('pendingMembers', () => {
  const a = { slot: '0xA' }
  const b = { slot: '0xB' }
  const c = { slot: '0xC' }

  it('keeps the messages whose slot Aztec has not registered, oldest first', () => {
    expect(pendingMembers([a, b, c], ['0xB'])).toEqual([a, c])
    expect(pendingMembers([a, b], ['0xA', '0xB'])).toEqual([])
  })

  it('keeps only the first message of a slot sent twice', () => {
    const again = { slot: '0xA', again: true }
    expect(pendingMembers([a, again, b], [])).toEqual([a, b])
  })
})

