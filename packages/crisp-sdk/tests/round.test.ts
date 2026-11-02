// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { bytesToHex, keccak256, zeroAddress } from 'viem'

import { ROUND_STAGES, assembleKeyChunks, getCommitteePublicKeyCandidates, getInputStartBlock, getRoundState, getSlotStatus } from '../src/round'

import type { Address, Hex } from 'viem'
import type { KeyChunkLog, RoundStage } from '../src/round'

const COORDINATOR = '0x00000000000000000000000000000000000000c0' as Address
const REGISTRY = '0x00000000000000000000000000000000000000d0' as Address
const PROGRAM = '0x00000000000000000000000000000000000000e0' as Address
const SLOT = '0x00000000000000000000000000000000000000f0' as Address
const E3_ID = (1n << 200n) + 7n

type FakeLog = { blockNumber: bigint; logIndex: number; args: Record<string, unknown> }

// A chain of 1000 blocks, block `n` at timestamp 1000 + 12n.
const HEAD = 999n
const timestampOf = (block: bigint) => 1_000n + 12n * block

const state = vi.hoisted(() => ({
  client: undefined as unknown,
}))

vi.mock('../src/chain', () => ({ getPublicClient: () => state.client }))

type World = {
  stage: RoundStage
  inputWindow: [bigint, bigint]
  e3Program: Address
  commitmentDeadline: bigint
  requestTime: bigint
  logs: Record<string, FakeLog[]>
}

const world = (overrides: Partial<World> = {}): World => ({
  stage: 'KeyPublished',
  inputWindow: [100n, 1_000n],
  e3Program: PROGRAM,
  commitmentDeadline: 900n,
  requestTime: timestampOf(50n),
  logs: {},
  ...overrides,
})

const install = (w: World) => {
  const readContract = vi.fn(async ({ functionName }: { functionName: string }) => {
    switch (functionName) {
      case 'getE3':
        return {
          inputWindow: w.inputWindow,
          e3Program: w.e3Program,
          requestBlock: w.requestTime,
          committeePublicKey: '0x' + 'ab'.repeat(32),
          paramSet: 0,
        }
      case 'getE3Stage':
        return ROUND_STAGES.indexOf(w.stage)
      case 'inputCommitmentDeadline':
        return w.commitmentDeadline
      case 'ciphernodeRegistry':
        return REGISTRY
      case 'interfold':
        return COORDINATOR
      default:
        throw new Error(`unexpected read ${functionName}`)
    }
  })

  const getLogs = vi.fn(async ({ event, args, fromBlock, toBlock }: { event: { name: string }; args: Record<string, unknown>; fromBlock: bigint; toBlock: bigint }) =>
    (w.logs[event.name] ?? []).filter(
      (log) => log.blockNumber >= fromBlock && log.blockNumber <= toBlock && Object.entries(args).every(([k, v]) => log.args[k] === v),
    ),
  )

  const getBlock = vi.fn(async (a: { blockTag?: 'latest'; blockNumber?: bigint }) => {
    const number = a.blockTag === 'latest' ? HEAD : (a.blockNumber as bigint)
    return { number, timestamp: timestampOf(number) }
  })

  state.client = { readContract, getLogs, getBlock, getBlockNumber: async () => HEAD }

  return { readContract, getLogs, getBlock }
}

describe('getRoundState', () => {
  const read = (now?: bigint) => getRoundState({ interfoldAddress: COORDINATOR, e3Id: E3_ID, chainId: 1, now })

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reports the coordinator fields', async () => {
    install(world())

    expect(await read(500n)).toEqual({
      e3Id: E3_ID,
      stage: 'KeyPublished',
      inputWindow: { start: 100n, end: 1_000n },
      commitmentDeadline: 900n,
      requestTime: timestampOf(50n),
      committeePublicKeyCommitment: '0x' + 'ab'.repeat(32),
      paramSet: 0,
      e3Program: PROGRAM,
      acceptingInputs: true,
    })
  })

  it.each([
    [99n, false],
    [100n, true],
    [899n, true],
    // CRISPProgram refuses a commitment at the deadline, a tail before the window ends.
    [900n, false],
    [999n, false],
    [1_000n, false],
  ])('judges the window at t=%s: acceptingInputs=%s', async (now, expected) => {
    install(world())

    expect((await read(now)).acceptingInputs).toBe(expected)
  })

  it.each(ROUND_STAGES.filter((stage) => stage !== 'KeyPublished'))('is not accepting inputs in stage %s, even inside the window', async (stage) => {
    install(world({ stage }))

    expect((await read(500n)).acceptingInputs).toBe(false)
  })

  it('takes the time from the latest block when none is given', async () => {
    install(world({ inputWindow: [timestampOf(HEAD) - 10n, timestampOf(HEAD) + 1_000n], commitmentDeadline: timestampOf(HEAD) + 500n }))

    expect((await read()).acceptingInputs).toBe(true)

    install(world({ inputWindow: [timestampOf(HEAD) + 1n, timestampOf(HEAD) + 1_000n], commitmentDeadline: timestampOf(HEAD) + 500n }))

    expect((await read()).acceptingInputs).toBe(false)
  })

  it('has no commitment deadline and accepts nothing for a round without a program', async () => {
    const { readContract } = install(world({ stage: 'Requested', e3Program: zeroAddress }))

    const round = await read(500n)

    expect(round.commitmentDeadline).toBeUndefined()
    expect(round.acceptingInputs).toBe(false)
    expect(readContract).not.toHaveBeenCalledWith(expect.objectContaining({ functionName: 'inputCommitmentDeadline' }))
  })
})

describe('assembleKeyChunks', () => {
  const key = Uint8Array.from({ length: 200 }, (_, i) => (i * 7 + 3) % 256)
  const hash = keccak256(key)
  const alice = '0x00000000000000000000000000000000000000a1' as Address
  const bob = '0x00000000000000000000000000000000000000b2' as Address

  const chunksOf = (bytes: Uint8Array, publisher: Address, candidateHash: Hex = keccak256(bytes), size = 80): KeyChunkLog[] => {
    const count = Math.ceil(bytes.length / size)
    return Array.from({ length: count }, (_, chunkIndex) => ({
      blockNumber: 10n,
      logIndex: chunkIndex,
      publisher,
      candidateHash,
      chunkIndex,
      chunkCount: count,
      totalLength: bytes.length,
      chunk: bytesToHex(bytes.slice(chunkIndex * size, (chunkIndex + 1) * size)),
    }))
  }

  it('reassembles a complete group', () => {
    const [candidate] = assembleKeyChunks(chunksOf(key, alice))

    expect(candidate.publicKey).toEqual(key)
    expect(candidate.publisher).toBe(alice)
    expect(candidate.source).toBe('chunks')
  })

  it('reassembles chunks that arrive out of order', () => {
    const [candidate] = assembleKeyChunks(chunksOf(key, alice).reverse())

    expect(candidate.publicKey).toEqual(key)
  })

  it('ignores a repeated chunk', () => {
    const logs = chunksOf(key, alice)

    expect(assembleKeyChunks([...logs, logs[1]]).map((c) => c.publicKey)).toEqual([key])
  })

  it('drops a group with a missing chunk', () => {
    expect(assembleKeyChunks(chunksOf(key, alice).slice(1))).toEqual([])
    expect(assembleKeyChunks(chunksOf(key, alice).slice(0, 2))).toEqual([])
  })

  it('drops a group whose bytes do not hash to the candidate hash', () => {
    expect(assembleKeyChunks(chunksOf(key, alice, keccak256('0x1234')))).toEqual([])
  })

  it('drops a group whose length differs from totalLength', () => {
    const logs = chunksOf(key, alice).map((log) => ({ ...log, totalLength: key.length + 1 }))

    expect(assembleKeyChunks(logs)).toEqual([])
  })

  it('drops a chunk whose index is outside its count', () => {
    const logs = chunksOf(key, alice)
    logs[2] = { ...logs[2], chunkIndex: 3 }

    expect(assembleKeyChunks(logs)).toEqual([])
  })

  it('keeps groups of different publishers apart, and one candidate per publisher', () => {
    const other = Uint8Array.from({ length: 160 }, (_, i) => (i * 13 + 1) % 256)
    const third = Uint8Array.from({ length: 90 }, (_, i) => (i * 5 + 9) % 256)

    const candidates = assembleKeyChunks([...chunksOf(key, alice), ...chunksOf(other, bob), ...chunksOf(third, alice)])

    expect(candidates.map((c) => [c.publisher, c.publicKey.length])).toEqual([
      [alice, 200],
      [bob, 160],
    ])
    expect(hash).toBe(keccak256(candidates[0].publicKey))
  })

  it('does not let one publisher complete another publisher\'s group', () => {
    const logs = [...chunksOf(key, alice).slice(0, 2), ...chunksOf(key, bob).slice(2)]

    expect(assembleKeyChunks(logs)).toEqual([])
  })
})

describe('getCommitteePublicKeyCandidates', () => {
  const read = (extra: { fromBlock?: bigint; toBlock?: bigint; maxCandidates?: number } = {}) =>
    getCommitteePublicKeyCandidates({ interfoldAddress: COORDINATOR, e3Id: E3_ID, chainId: 1, ...extra })

  const published = (blockNumber: bigint, publicKey: Hex, logIndex = 0, e3Id = E3_ID): FakeLog => ({
    blockNumber,
    logIndex,
    args: { e3Id, publicKey, nodes: [], pkCommitment: '0x00', proof: '0x' },
  })

  const chunkLog = (blockNumber: bigint, logIndex: number, publisher: Address, bytes: Uint8Array, chunkIndex: number, size: number): FakeLog => ({
    blockNumber,
    logIndex,
    args: {
      e3Id: E3_ID,
      publisher,
      candidateHash: keccak256(bytes),
      chunkIndex,
      chunkCount: Math.ceil(bytes.length / size),
      totalLength: bytes.length,
      chunk: bytesToHex(bytes.slice(chunkIndex * size, (chunkIndex + 1) * size)),
    },
  })

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reads the registry the coordinator names, from the block of the request', async () => {
    const { getLogs } = install(world({ requestTime: timestampOf(50n) }))

    await read()

    expect(getLogs).toHaveBeenCalledTimes(2)
    for (const [query] of getLogs.mock.calls) {
      expect(query).toMatchObject({ address: REGISTRY, args: { e3Id: E3_ID }, fromBlock: 50n, toBlock: HEAD })
    }
  })

  it('uses an explicit fromBlock without converting the request time', async () => {
    const { getLogs, getBlock } = install(world())

    await read({ fromBlock: 7n })

    expect(getLogs.mock.calls[0][0]).toMatchObject({ fromBlock: 7n })
    expect(getBlock).not.toHaveBeenCalled()
  })

  it('returns event and chunk candidates in chain order, each key once', async () => {
    const eventKey = Uint8Array.from({ length: 50 }, (_, i) => i + 1)
    const chunkedKey = Uint8Array.from({ length: 150 }, (_, i) => (i * 3) % 251)
    install(
      world({
        logs: {
          CommitteePublished: [published(60n, bytesToHex(eventKey)), published(70n, bytesToHex(eventKey), 1), published(65n, '0x')],
          CommitteePublicKeyChunkPublished: [
            chunkLog(61n, 0, SLOT, chunkedKey, 1, 100),
            chunkLog(61n, 1, SLOT, chunkedKey, 0, 100),
          ],
        },
      }),
    )

    const candidates = await read()

    expect(candidates.map((c) => [c.source, c.publicKey.length])).toEqual([
      ['event', 50],
      ['chunks', 150],
    ])
  })

  it('ignores other rounds\' logs', async () => {
    install(world({ logs: { CommitteePublished: [published(60n, '0x0102', 0, E3_ID + 1n)] } }))

    expect(await read()).toEqual([])
  })

  it('caps the candidates at 20 by default and at maxCandidates when given', async () => {
    const logs = Array.from({ length: 30 }, (_, i) => published(60n + BigInt(i), bytesToHex(Uint8Array.of(i + 1))))
    install(world({ logs: { CommitteePublished: logs } }))

    const candidates = await read()
    expect(candidates).toHaveLength(20)
    expect(candidates[0].publicKey).toEqual(Uint8Array.of(1))
    expect(candidates[19].publicKey).toEqual(Uint8Array.of(20))

    expect(await read({ maxCandidates: 3 })).toHaveLength(3)
  })

  it('counts duplicates once toward the cap', async () => {
    const logs = [...Array.from({ length: 25 }, (_, i) => published(60n + BigInt(i), '0x0a0b')), published(90n, '0x0c')]
    install(world({ logs: { CommitteePublished: logs } }))

    expect((await read()).map((c) => bytesToHex(c.publicKey))).toEqual(['0x0a0b', '0x0c'])
  })
})

describe('getSlotStatus', () => {
  const committed = (blockNumber: bigint, slot: Address = SLOT, e3Id = E3_ID): FakeLog => ({ blockNumber, logIndex: 0, args: { e3Id, slotAddress: slot } })
  const read = (extra: { fromBlock?: bigint } = {}) => getSlotStatus({ programAddress: PROGRAM, e3Id: E3_ID, slot: SLOT, chainId: 1, ...extra })

  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('is inactive for a slot with no committed input', async () => {
    install(world({ logs: { InputCommitted: [committed(200n, '0x00000000000000000000000000000000000000f1' as Address), committed(200n, SLOT, E3_ID + 1n)] } }))

    expect(await read()).toEqual({ active: false, entries: 0 })
  })

  it('counts every committed entry of the slot in the round', async () => {
    install(world({ logs: { InputCommitted: [committed(200n), committed(300n), committed(300n, '0x00000000000000000000000000000000000000f1' as Address)] } }))

    expect(await read()).toEqual({ active: true, entries: 2 })
  })

  it('starts scanning at the block where the input window opened', async () => {
    const { getLogs } = install(world({ inputWindow: [timestampOf(120n), timestampOf(400n)] }))

    await read()

    expect(getLogs.mock.calls[0][0]).toMatchObject({ address: PROGRAM, fromBlock: 120n, toBlock: HEAD, args: { e3Id: E3_ID, slotAddress: SLOT } })
  })

  it('does not look the window up when given a fromBlock', async () => {
    const { readContract } = install(world({ logs: { InputCommitted: [committed(200n)] } }))

    expect(await read({ fromBlock: 150n })).toEqual({ active: true, entries: 1 })
    expect(readContract).not.toHaveBeenCalled()
  })

  it('exposes the input start block', async () => {
    install(world({ inputWindow: [timestampOf(120n), timestampOf(400n)] }))

    expect(await getInputStartBlock({ programAddress: PROGRAM, e3Id: E3_ID, chainId: 1 })).toBe(120n)
  })
})
