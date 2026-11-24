// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import {
  type AztecSession,
  type EnrolledMessage,
  type RoundClosed,
  type WithOrigin,
  CrispAztecVotes,
  connectAztec,
  getEnrolledMessages,
  getL1Round,
  getRootWitness,
  getRoundConfig,
  getSentMessages,
  getVotesRound,
  interfoldAbi,
  keyContent,
  programAbi,
  publishCommitteeKey,
  roundContent,
  roundIdOf,
  submitInputRoot,
  votesRoundContent,
} from '@crisp-e3/aztec'
import { CrispAztec } from '@crisp-e3/aztec/passport'
import { createPublicClient, createWalletClient, getAddress, hexToBigInt, http, type Hex, type PublicClient, type WalletClient } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import type { KeeperConfig } from './config'
import { type Action, dueActions, isFinished, type RoundState } from './plan'

export type Log = (message: string) => void

/**
 * Drives every CRISP round on Aztec through the steps nobody else has a reason to take: opening it on Aztec,
 * relaying the committee key, (for token-weighted rounds) consuming the ENROLL messages, closing the round, and
 * delivering the input root to L1. Every step is permissionless and checked against on-chain state first, so the
 * keeper can be restarted or run twice without harm.
 */
export class Keeper {
  /** The end of each known round's input window. */
  private readonly inputEnds = new Map<bigint, bigint>()
  private readonly finished = new Set<bigint>()
  private nextScanBlock: bigint

  private constructor(
    private readonly config: KeeperConfig,
    private readonly session: AztecSession,
    private readonly crisp: CrispAztec | CrispAztecVotes,
    private readonly l1: PublicClient,
    private readonly l1Wallet: WalletClient,
    private readonly log: Log,
  ) {
    this.nextScanBlock = config.startBlock
  }

  static async start(config: KeeperConfig, log: Log): Promise<Keeper> {
    const session = await connectAztec(config.aztecNodeUrl)
    const crisp =
      config.kind === 'votes' ? await CrispAztecVotes.connect(session, config.contract) : await CrispAztec.connect(session, config.contract)
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
      for (const { args } of sent) await this.learn(args.e3Id as bigint)
      this.nextScanBlock = head + 1n
    }

    const open = [...this.inputEnds.keys()].filter((e3Id) => !this.finished.has(e3Id))
    if (open.length === 0) return

    const [opened, keyed, closed, latest] = await Promise.all([
      this.crisp.logs('RoundOpened'),
      this.crisp.logs('KeyPublished'),
      this.crisp.logs('RoundClosed'),
      this.session.node.getBlock('latest'),
    ])
    const l2Now = latest ? BigInt(latest.header.globalVariables.timestamp) : 0n

    for (const e3Id of open) {
      const { round, pending } = await this.read(e3Id, {
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
            pending,
            closed.find((l) => l.e3Id === e3Id),
          )
        } catch (error) {
          this.log(`Round ${e3Id}: ${action} failed: ${describe(error)}`)
          break
        }
      }
    }
  }

  private async learn(e3Id: bigint): Promise<void> {
    if (this.inputEnds.has(e3Id)) return
    const e3 = await this.l1.readContract({ address: this.crisp.interfold, abi: interfoldAbi, functionName: 'getE3', args: [e3Id] })
    this.inputEnds.set(e3Id, e3.inputWindow[1])
    this.log(`Round ${e3Id}: found; its input window ends at ${e3.inputWindow[1]}`)
  }

  /**
   * Where the round stands, with the ENROLL messages that Aztec has not consumed: one per `Enrolled` event whose slot is
   * not in the census yet. They are read only when `enroll` could consume them (a token-weighted round that is open on
   * Aztec and still accepts inputs), and the `enroll` step uses this list rather than reading it again.
   */
  private async read(e3Id: bigint, l2: Pick<RoundState, 'l2Opened' | 'l2KeyPublished' | 'l2Closed' | 'l2Now'>) {
    const [stage, l1Round] = await Promise.all([
      this.l1.readContract({ address: this.crisp.interfold, abi: interfoldAbi, functionName: 'getE3Stage', args: [e3Id] }),
      getL1Round(this.l1, this.config.program, e3Id),
    ])
    const inputEnd = this.inputEnds.get(e3Id)!
    let pending: EnrolledMessage[] = []
    if (this.crisp instanceof CrispAztecVotes && l2.l2Opened && !l2.l2Closed && l2.l2Now < inputEnd) {
      const enrolled = new Set((await this.crisp.logs('MemberRegistered', { e3Id })).map((log) => log.slot.toLowerCase()))
      const messages = await getEnrolledMessages(this.l1, this.config.program, e3Id, { fromBlock: this.config.startBlock })
      pending = messages.filter(({ slot }) => !enrolled.has(slot.toLowerCase()))
    }
    const round: RoundState = {
      e3Id,
      stage,
      l1KeyRelayed: l1Round.keyRelayed,
      l1RootSubmitted: l1Round.rootSubmitted,
      inputEnd,
      pendingEnrollments: pending.length,
      ...l2,
    }

    return { round, pending }
  }

  private async perform(action: Action, round: RoundState, pending: EnrolledMessage[], closeLog: WithOrigin<RoundClosed> | undefined) {
    const { e3Id } = round
    const program = this.config.program
    switch (action) {
      case 'openRound': {
        let txHash
        if (this.crisp instanceof CrispAztecVotes) {
          const config = await getVotesRound(this.l1, program, e3Id)
          ;({ txHash } = await this.crisp.openRound(config, await this.sentMessage(e3Id, votesRoundContent(config), 'ROUND')))
        } else {
          const config = await getRoundConfig(this.l1, program, e3Id)
          ;({ txHash } = await this.crisp.openRound(config, await this.sentMessage(e3Id, roundContent(config), 'ROUND')))
        }
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
        const message = await this.sentMessage(e3Id, keyContent(roundIdOf(e3Id), key), 'KEY')
        const { txHash } = await this.crisp.publishKey(e3Id, key, message)
        this.log(`Round ${e3Id}: committee key published on Aztec in ${txHash}`)
        return
      }
      case 'enroll': {
        if (!(this.crisp instanceof CrispAztecVotes)) throw new Error('only token-weighted rounds enroll slots')
        for (const enrollment of pending) {
          // Each message is a separate transaction, so one that fails (consumed by another keeper meanwhile) does not stop the rest.
          try {
            const { txHash } = await this.crisp.enroll({ e3Id, ...enrollment })
            this.log(`Round ${e3Id}: slot ${enrollment.slot} enrolled on Aztec in ${txHash}`)
          } catch (error) {
            this.log(`Round ${e3Id}: enrolling ${enrollment.slot} failed: ${describe(error)}`)
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

  /** The Inbox message the program sent with `content`, which Aztec consumes. */
  private async sentMessage(e3Id: bigint, content: bigint, name: 'ROUND' | 'KEY') {
    const message = (await getSentMessages(this.l1, this.config.program, e3Id)).find((m) => hexToBigInt(m.content) === content)
    if (!message) throw new Error(`the program has not sent the ${name} message`)

    return message
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
