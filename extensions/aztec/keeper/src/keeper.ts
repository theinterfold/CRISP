// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import {
  type AztecSession,
  type RoundClosed,
  type WithOrigin,
  CrispAztec,
  connectAztec,
  decodeCustomParams,
  getL1Round,
  getRootWitness,
  getRoundConfig,
  getSentMembers,
  getSentMessages,
  interfoldAbi,
  keyContent,
  programAbi,
  publishCommitteeKey,
  roundContent,
  registersOnL1,
  roundIdOf,
  submitInputRoot,
  type SentMember,
} from '@crisp-e3/aztec'
import { createPublicClient, createWalletClient, getAddress, hexToBigInt, http, type Hex, type PublicClient, type WalletClient } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import type { KeeperConfig } from './config'
import { type Action, dueActions, isFinished, pendingMembers, type RoundState } from './plan'

export type Log = (message: string) => void

/** What the keeper reads about a round that does not change once the round exists. */
type RoundFacts = { inputEnd: bigint; l1Registration: boolean; fromBlock: bigint }

/**
 * Drives every CRISP round on Aztec through the steps nobody else has a reason to take: opening it on Aztec,
 * relaying the committee key, carrying the members an L1 registrar registered to Aztec, closing the round, and delivering
 * the input root to L1. Every step is permissionless
 * and checked against on-chain state first, so the keeper can be restarted or run twice without harm.
 */
export class Keeper {
  private readonly facts = new Map<bigint, RoundFacts>()
  private readonly finished = new Set<bigint>()
  /** Members to add, as found by the latest `read` of each round. */
  private readonly pending = new Map<bigint, SentMember[]>()
  private nextScanBlock: bigint

  private constructor(
    private readonly config: KeeperConfig,
    private readonly session: AztecSession,
    private readonly crisp: CrispAztec,
    private readonly l1: PublicClient,
    private readonly l1Wallet: WalletClient,
    private readonly log: Log,
  ) {
    this.nextScanBlock = config.startBlock
  }

  static async start(config: KeeperConfig, log: Log): Promise<Keeper> {
    const session = await connectAztec(config.aztecNodeUrl)
    const crisp = await CrispAztec.connect(session, config.contract)
    const l1 = createPublicClient({ transport: http(config.l1RpcUrl) })
    const l1Wallet = createWalletClient({ account: privateKeyToAccount(config.l1PrivateKey), transport: http(config.l1RpcUrl) })
    const interfold = await l1.readContract({ address: config.program, abi: programAbi, functionName: 'interfold' })
    if (getAddress(interfold) !== crisp.interfold) {
      await session.stop()
      throw new Error(`Contract ${crisp.address.toString()} serves Interfold ${crisp.interfold}, but program ${config.program} is bound to ${interfold}`)
    }
    log(`Keeper for program ${config.program} and contract ${crisp.address.toString()}; sending as ${session.address.toString()} on Aztec`)

    return new Keeper(config, session, crisp, l1, l1Wallet, log)
  }

  async stop(): Promise<void> {
    await this.session.stop()
  }

  /** Run until `signal` aborts. A failed step is logged and retried on the next pass. */
  async run(signal: AbortSignal): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.tick()
      } catch (error) {
        this.log(`Pass failed: ${describe(error)}`)
      }
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, this.config.pollIntervalMs)
        signal.addEventListener('abort', () => (clearTimeout(timer), resolve(undefined)), { once: true })
      })
    }
  }

  /** One pass: find the rounds, read where each stands, and take the steps that are due. */
  async tick(): Promise<void> {
    const head = await this.l1.getBlockNumber()
    // An idle L1 has no new block since the last pass: `fromBlock > toBlock` is an invalid range for the node.
    if (this.nextScanBlock <= head) {
      const sent = await this.l1.getContractEvents({
        address: this.config.program,
        abi: programAbi,
        eventName: 'RoundConfigSent',
        fromBlock: this.nextScanBlock,
        toBlock: head,
      })
      for (const { args, blockNumber } of sent) await this.learn(args.e3Id as bigint, blockNumber)
      this.nextScanBlock = head + 1n
    }

    const open = [...this.facts.keys()].filter((e3Id) => !this.finished.has(e3Id))
    if (open.length === 0) return

    const [opened, keyed, closed, latest] = await Promise.all([
      this.crisp.logs('RoundOpened'),
      this.crisp.logs('KeyPublished'),
      this.crisp.logs('RoundClosed'),
      this.session.node.getBlock('latest'),
    ])
    const l2Now = latest ? BigInt(latest.header.globalVariables.timestamp) : 0n

    for (const e3Id of open) {
      const round = await this.read(e3Id, {
        l2Opened: opened.some((l) => l.e3Id === e3Id),
        l2KeyPublished: keyed.some((l) => l.e3Id === e3Id),
        l2Closed: closed.some((l) => l.e3Id === e3Id),
        l2Now,
      })
      if (isFinished(round)) {
        this.finished.add(e3Id)
        continue
      }
      for (const action of dueActions(round)) {
        try {
          await this.perform(
            action,
            round,
            closed.find((l) => l.e3Id === e3Id),
          )
        } catch (error) {
          this.log(`Round ${e3Id}: ${action} failed: ${describe(error)}`)
          break
        }
      }
    }
  }

  private async learn(e3Id: bigint, fromBlock: bigint): Promise<void> {
    if (this.facts.has(e3Id)) return
    const interfold = await this.l1.readContract({ address: this.config.program, abi: programAbi, functionName: 'interfold' })
    const e3 = await this.l1.readContract({ address: interfold, abi: interfoldAbi, functionName: 'getE3', args: [e3Id] })
    const l1Registration = registersOnL1(decodeCustomParams(e3.customParams))
    this.facts.set(e3Id, { inputEnd: e3.inputWindow[1], l1Registration, fromBlock })
    this.log(
      `Round ${e3Id}: found; its input window ends at ${e3.inputWindow[1]}; voters register on ${l1Registration ? 'L1 (the keeper carries their MEMBER messages)' : 'Aztec'}`,
    )
  }

  private async read(e3Id: bigint, l2: Pick<RoundState, 'l2Opened' | 'l2KeyPublished' | 'l2Closed' | 'l2Now'>): Promise<RoundState> {
    const interfold = await this.l1.readContract({ address: this.config.program, abi: programAbi, functionName: 'interfold' })
    const [stage, l1Round] = await Promise.all([
      this.l1.readContract({ address: interfold, abi: interfoldAbi, functionName: 'getE3Stage', args: [e3Id] }),
      getL1Round(this.l1, this.config.program, e3Id),
    ])

    const { inputEnd, l1Registration } = this.facts.get(e3Id)!
    const registering = l1Registration && l2.l2Opened && !l2.l2Closed && l2.l2Now < inputEnd
    const pendingMembers = registering ? await this.findPendingMembers(e3Id) : 0

    return {
      e3Id,
      stage,
      l1KeyRelayed: l1Round.keyRelayed,
      l1RootSubmitted: l1Round.rootSubmitted,
      inputEnd,
      l1Registration,
      pendingMembers,
      ...l2,
    }
  }

  /**
   * The MEMBER messages of the round that Aztec has not consumed (see `pendingMembers`), remembered for `perform`.
   */
  private async findPendingMembers(e3Id: bigint): Promise<number> {
    const [sent, registered] = await Promise.all([
      getSentMembers(this.l1, this.config.program, e3Id, this.facts.get(e3Id)!.fromBlock),
      this.crisp.logs('MemberRegistered', { e3Id }),
    ])
    const pending = pendingMembers(sent, registered.map((log) => log.slot))
    this.pending.set(e3Id, pending)

    return pending.length
  }

  private async perform(action: Action, round: RoundState, closeLog: WithOrigin<RoundClosed> | undefined) {
    const { e3Id } = round
    const program = this.config.program
    switch (action) {
      case 'openRound': {
        const config = await getRoundConfig(this.l1, program, e3Id)
        const message = (await getSentMessages(this.l1, program, e3Id)).find((m) => hexToBigInt(m.content) === roundContent(config))
        if (!message) throw new Error('the program has not sent the ROUND message')
        const { txHash } = await this.crisp.openRound(config, message)
        this.log(`Round ${e3Id}: opened on Aztec in ${txHash}`)
        return
      }
      case 'relayKey': {
        const hash = await publishCommitteeKey(this.l1Wallet, this.l1, program, e3Id)
        await this.l1.waitForTransactionReceipt({ hash })
        this.log(`Round ${e3Id}: committee key relayed to Aztec in ${hash}`)
        return
      }
      case 'publishKey': {
        const key = await this.relayedKey(e3Id)
        const message = (await getSentMessages(this.l1, program, e3Id)).find(
          (m) => hexToBigInt(m.content) === keyContent(roundIdOf(e3Id), key),
        )
        if (!message) throw new Error('the program has not sent the KEY message')
        const { txHash } = await this.crisp.publishKey(e3Id, key, message)
        this.log(`Round ${e3Id}: committee key published on Aztec in ${txHash}`)
        return
      }
      case 'addMembers': {
        // One member failing (its message not in a block yet, the window closing) must not hold back the others.
        for (const { slot, message } of this.pending.get(e3Id) ?? []) {
          try {
            const { txHash } = await this.crisp.addMemberFromL1(e3Id, slot, message)
            this.log(`Round ${e3Id}: member ${slot} added on Aztec in ${txHash}`)
          } catch (error) {
            this.log(`Round ${e3Id}: adding member ${slot} failed: ${describe(error)}`)
          }
        }
        return
      }
      case 'closeRound': {
        const { txHash } = await this.crisp.closeRound(e3Id)
        this.log(`Round ${e3Id}: closed on Aztec in ${txHash}`)
        return
      }
      case 'submitRoot': {
        if (!closeLog) throw new Error('the close log is missing')
        const witness = await getRootWitness(this.session.node, {
          closeTx: closeLog.origin.txHash,
          contract: this.crisp.address,
          program,
          l1ChainId: this.session.l1ChainId,
          rollupVersion: this.session.rollupVersion,
          e3Id,
          inputRoot: closeLog.inputRoot,
          numInputs: BigInt(closeLog.numInputs),
        })
        if (!witness) {
          this.log(`Round ${e3Id}: waiting for the epoch's proof to reach the Outbox`)
          return
        }
        const hash = await submitInputRoot(this.l1Wallet, this.l1, program, {
          e3Id,
          inputRoot: closeLog.inputRoot,
          numInputs: BigInt(closeLog.numInputs),
          witness,
        })
        await this.l1.waitForTransactionReceipt({ hash })
        this.log(`Round ${e3Id}: input root delivered to L1 in ${hash}`)
      }
    }
  }

  /** The key the program relayed, as it announced it. */
  private async relayedKey(e3Id: bigint): Promise<Hex> {
    const [relayed] = await this.l1.getContractEvents({
      address: this.config.program,
      abi: programAbi,
      eventName: 'CommitteeKeyRelayed',
      args: { e3Id },
      fromBlock: this.config.startBlock,
    })
    if (!relayed) throw new Error('the program has not relayed the committee key')

    return relayed.args.committeePublicKey as Hex
  }
}

const describe = (error: unknown): string => (error instanceof Error ? error.message : String(error))
