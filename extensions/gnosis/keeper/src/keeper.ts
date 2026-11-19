// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import {
  crispGnosisProgramAbi,
  crispGnosisVotingAbi,
  blockRanges,
  crispGovernanceModuleAbi,
  encodeReceiveMessage,
  encodeRootMessage,
  executeNextTx,
  executeSignatures,
  findLog,
  getDelayState,
  getQueuedTx,
  getSignatures,
  homeMessageFromReceipt,
  type HomeMessage,
  interfoldAbi,
  roundIdOf,
  skipExpired,
} from '@crisp-e3/gnosis'
import {
  BaseError,
  ContractFunctionRevertedError,
  createPublicClient,
  createWalletClient,
  getAddress,
  http,
  keccak256,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

import type { KeeperConfig } from './config'
import { type Action, delayAction, dueActions, isFinished, type ProposalState, type RoundState } from './plan'

export type Log = (message: string) => void

/** The module's refusals that no later block can undo: the result does not pass, or it expired. */
const FINAL_REFUSALS = ['QuorumNotMet', 'NotApproved', 'ResultExpired']

/**
 * Drives every CRISP proposal through the steps nobody else has a reason to take: relaying the committee key, closing
 * the round, carrying the input root over the AMB, relaying the result and, optionally, executing the passed proposal and
 * the Delay's queue. Every step is permissionless and checked against on-chain state first, so the keeper can be
 * restarted or run twice without harm.
 */
export class Keeper {
  private readonly known = new Set<bigint>()
  private readonly finished = new Set<bigint>()
  /** The packed batch of each metadata CID the keeper has read. */
  private readonly batches = new Map<string, Hex>()
  private nextScanBlock: bigint
  private foreignAmb!: Address
  private homeAmb!: Address
  /** The ROOT message each closed round handed to the Home AMB. */
  private readonly roots = new Map<bigint, HomeMessage>()

  private constructor(
    private readonly config: KeeperConfig,
    private readonly sepolia: PublicClient,
    private readonly sepoliaWallet: WalletClient,
    private readonly chiado: PublicClient,
    private readonly chiadoWallet: WalletClient,
    private readonly log: Log,
  ) {
    this.nextScanBlock = config.startBlockSepolia
  }

  static async start(config: KeeperConfig, log: Log): Promise<Keeper> {
    const sepolia = createPublicClient({ transport: http(config.sepoliaRpcUrl) })
    const chiado = createPublicClient({ transport: http(config.chiadoRpcUrl) })
    const sepoliaWallet = createWalletClient({ account: privateKeyToAccount(config.sepoliaPrivateKey), transport: http(config.sepoliaRpcUrl) })
    const chiadoWallet = createWalletClient({ account: privateKeyToAccount(config.chiadoPrivateKey), transport: http(config.chiadoRpcUrl) })
    const keeper = new Keeper(config, sepolia, sepoliaWallet, chiado, chiadoWallet, log)

    // The two contracts must be each other's remote, or the ROOT would never reach the program.
    const [remote, foreignAmb, homeAmb] = await Promise.all([
      sepolia.readContract({ address: config.program, abi: crispGnosisProgramAbi, functionName: 'remote' }),
      sepolia.readContract({ address: config.program, abi: crispGnosisProgramAbi, functionName: 'foreignAmb' }),
      chiado.readContract({ address: config.voting, abi: crispGnosisVotingAbi, functionName: 'amb' }),
    ])
    if (getAddress(remote) !== config.voting) throw new Error(`Program ${config.program} sends to ${remote}, not to the voting contract ${config.voting}`)
    keeper.foreignAmb = getAddress(foreignAmb)
    keeper.homeAmb = getAddress(homeAmb)
    log(`Keeper for program ${config.program} and voting contract ${config.voting}${config.module ? `, module ${config.module}` : ''}`)

    return keeper
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

  /** One pass: find the proposals, read where each stands, take the steps that are due, then run the Delay's queue. */
  async tick(): Promise<void> {
    const head = await this.sepolia.getBlockNumber()
    // Chunked, with the cursor moved past a chunk only once it was read: a failed pass resumes at the failed chunk.
    for (const [from, to] of blockRanges(this.nextScanBlock, head)) {
      const created = await this.sepolia.getContractEvents({
        address: this.config.program,
        abi: crispGnosisProgramAbi,
        eventName: 'ProposalCreated',
        fromBlock: from,
        toBlock: to,
      })
      for (const { args } of created) {
        if (this.known.has(args.e3Id!)) continue
        this.known.add(args.e3Id!)
        this.log(`Round ${args.e3Id}: found`)
      }
      this.nextScanBlock = to + 1n
    }

    for (const e3Id of this.known) {
      if (this.finished.has(e3Id)) continue
      try {
        const round = await this.read(e3Id)
        if (isFinished(round)) {
          this.finished.add(e3Id)
          this.log(`Round ${e3Id}: finished`)
          continue
        }
        for (const action of dueActions(round)) await this.perform(action, e3Id)
      } catch (error) {
        this.log(`Round ${e3Id}: failed: ${describe(error)}`)
      }
    }

    if (this.config.module) await this.runQueue(this.config.module)
  }

  private async read(e3Id: bigint): Promise<RoundState> {
    const { program, voting } = this.config
    const roundId = roundIdOf(e3Id)
    const interfold = await this.sepolia.readContract({ address: program, abi: crispGnosisProgramAbi, functionName: 'interfold' })
    const [stage, l1Round, resultRelayed, round, result, latest] = await Promise.all([
      this.sepolia.readContract({ address: interfold, abi: interfoldAbi, functionName: 'getE3Stage', args: [e3Id] }),
      this.sepolia.readContract({ address: program, abi: crispGnosisProgramAbi, functionName: 'getRound', args: [e3Id] }),
      this.sepolia.readContract({ address: program, abi: crispGnosisProgramAbi, functionName: 'resultRelayed', args: [e3Id] }),
      this.chiado.readContract({ address: voting, abi: crispGnosisVotingAbi, functionName: 'roundOf', args: [roundId] }),
      this.chiado.readContract({ address: voting, abi: crispGnosisVotingAbi, functionName: 'resultOf', args: [roundId] }),
      this.chiado.getBlock({ blockTag: 'latest' }),
    ])

    return {
      e3Id,
      stage,
      keyRelayed: l1Round.keyRelayed,
      rootDelivered: l1Round.rootSubmitted,
      resultRelayed,
      opened: round.inputEnd !== 0n,
      closed: round.closed,
      resultResolved: result.resolved,
      numInputs: round.numInputs,
      inputEnd: round.inputEnd,
      now: latest.timestamp,
      proposal: this.config.module ? await this.proposalState(roundId, result.resolved, round.metadataCid, round.proposalHash) : undefined,
    }
  }

  /** Whether the module would queue the proposal now: ask it, with the batch the round's metadata pins. */
  private async proposalState(roundId: bigint, resolved: boolean, cid: string, proposalHash: Hex): Promise<ProposalState> {
    const module = this.config.module!
    if (await this.chiado.readContract({ address: module, abi: crispGovernanceModuleAbi, functionName: 'executed', args: [roundId] })) return 'executed'
    if (!resolved) return 'pending'

    let packed: Hex
    try {
      packed = await this.batch(cid, proposalHash)
    } catch (error) {
      this.log(`Round ${roundId}: cannot read the batch from the metadata ${cid}: ${describe(error)}`)
      return 'pending'
    }
    try {
      await this.chiado.simulateContract({
        address: module,
        abi: crispGovernanceModuleAbi,
        functionName: 'executeProposal',
        args: [roundId, packed],
        account: this.chiadoWallet.account,
      })
      return 'executable'
    } catch (error) {
      return FINAL_REFUSALS.includes(revertName(error) ?? '') ? 'rejected' : 'pending'
    }
  }

  /**
   * The packed batch of a proposal, from the metadata the proposer pinned (`packedTransactions`). A batch whose hash is
   * not the round's `proposalHash` is refused and not remembered: the metadata host may answer correctly later.
   */
  private async batch(cid: string, proposalHash: Hex): Promise<Hex> {
    const known = this.batches.get(cid)
    if (known) return known
    const response = await fetch(this.config.metadataUrl!.replace('{cid}', cid))
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const { packedTransactions } = (await response.json()) as { packedTransactions?: Hex }
    if (!packedTransactions) throw new Error('the metadata has no packedTransactions')
    if (keccak256(packedTransactions) !== proposalHash) throw new Error(`the batch in the metadata does not hash to the proposal hash ${proposalHash}`)
    this.batches.set(cid, packedTransactions)

    return packedTransactions
  }

  private async perform(action: Action, e3Id: bigint): Promise<void> {
    const { program, voting } = this.config
    const roundId = roundIdOf(e3Id)
    switch (action) {
      case 'relayKey': {
        const { request } = await this.sepolia.simulateContract({
          address: program,
          abi: crispGnosisProgramAbi,
          functionName: 'publishCommitteeKey',
          args: [e3Id],
          account: this.sepoliaWallet.account,
        })
        const hash = await this.mine(this.sepoliaWallet, this.sepolia, request)
        this.log(`Round ${e3Id}: committee key sent to Chiado in ${hash}`)
        return
      }
      case 'closeRound': {
        const { request } = await this.chiado.simulateContract({
          address: voting,
          abi: crispGnosisVotingAbi,
          functionName: 'closeRound',
          args: [roundId],
          account: this.chiadoWallet.account,
        })
        const hash = await this.mine(this.chiadoWallet, this.chiado, request)
        this.log(`Round ${e3Id}: closed on Chiado in ${hash}`)
        return
      }
      case 'deliverRoot': {
        const message = await this.rootMessage(roundId)
        const signatures = await getSignatures(this.chiado, this.config.ambHelper, message.encodedData)
        if (!signatures) {
          this.log(`Round ${e3Id}: waiting for the AMB validators to sign the root`)
          return
        }
        const hash = await executeSignatures(this.sepoliaWallet, this.sepolia, this.foreignAmb, message.encodedData, signatures)
        await this.sepolia.waitForTransactionReceipt({ hash })
        this.log(`Round ${e3Id}: input root delivered to Sepolia in ${hash}`)
        return
      }
      case 'relayResult': {
        const { request } = await this.sepolia.simulateContract({
          address: program,
          abi: crispGnosisProgramAbi,
          functionName: 'relayResult',
          args: [e3Id],
          account: this.sepoliaWallet.account,
        })
        const hash = await this.mine(this.sepoliaWallet, this.sepolia, request)
        this.log(`Round ${e3Id}: result sent to Chiado in ${hash}`)
        return
      }
      case 'executeProposal': {
        const { metadataCid, proposalHash } = await this.chiado.readContract({ address: voting, abi: crispGnosisVotingAbi, functionName: 'roundOf', args: [roundId] })
        const { request } = await this.chiado.simulateContract({
          address: this.config.module!,
          abi: crispGovernanceModuleAbi,
          functionName: 'executeProposal',
          args: [roundId, await this.batch(metadataCid, proposalHash)],
          account: this.chiadoWallet.account,
        })
        const hash = await this.mine(this.chiadoWallet, this.chiado, request)
        this.log(`Round ${e3Id}: proposal queued in the Delay in ${hash}`)
      }
    }
  }

  /**
   * The ROOT message the closing transaction handed to the Home AMB. The transaction may hold other requests of the
   * AMB, so the one carrying this round's ROOT (as `closeRound` encoded it) is picked, not the first.
   */
  private async rootMessage(roundId: bigint): Promise<HomeMessage> {
    const known = this.roots.get(roundId)
    if (known) return known

    const closed = await findLog(
      (fromBlock, toBlock) =>
        this.chiado.getContractEvents({ address: this.config.voting, abi: crispGnosisVotingAbi, eventName: 'RoundClosed', args: { roundId }, fromBlock, toBlock }),
      this.config.startBlockChiado,
      await this.chiado.getBlockNumber(),
    )
    if (!closed) throw new Error('the voting contract has no RoundClosed log')
    const { root, numInputs } = closed.args
    const receipt = await this.chiado.getTransactionReceipt({ hash: closed.transactionHash })
    const message = homeMessageFromReceipt(receipt, this.homeAmb, encodeReceiveMessage(encodeRootMessage(roundId, root!, numInputs!)))
    if (!message) throw new Error('the closing transaction handed no ROOT message of this round to the Home AMB')
    this.roots.set(roundId, message)

    return message
  }

  /** Run the Delay's next queued transaction once its cooldown has passed, or skip its expired head. */
  private async runQueue(module: Address): Promise<void> {
    const delay = await this.chiado.readContract({ address: module, abi: crispGovernanceModuleAbi, functionName: 'target' })
    const [state, latest] = await Promise.all([getDelayState(this.chiado, delay), this.chiado.getBlock({ blockTag: 'latest' })])
    const action = delayAction({
      queued: state.txNonce < state.queueNonce,
      readyAt: state.readyAt ?? 0n,
      expiresAt: state.expiresAt,
      now: latest.timestamp,
    })
    if (!action) return

    try {
      if (action === 'skipExpired') {
        const hash = await skipExpired(this.chiadoWallet, this.chiado, delay)
        await this.chiado.waitForTransactionReceipt({ hash })
        this.log(`Delay ${delay}: skipped expired queued transactions from ${state.txNonce} in ${hash}`)
        return
      }
      const tx = await getQueuedTx(this.chiado, delay, state.txNonce, this.config.startBlockChiado)
      const hash = await executeNextTx(this.chiadoWallet, this.chiado, delay, tx)
      await this.chiado.waitForTransactionReceipt({ hash })
      this.log(`Delay ${delay}: executed queued transaction ${state.txNonce} in ${hash}`)
    } catch (error) {
      this.log(`Delay ${delay}: ${action} for queued transaction ${state.txNonce} failed: ${describe(error)}`)
    }
  }

  /** Send a simulated call and wait until it is mined. */
  private async mine(wallet: WalletClient, client: PublicClient, request: Parameters<WalletClient['writeContract']>[0]): Promise<Hex> {
    const hash = await wallet.writeContract(request)
    await client.waitForTransactionReceipt({ hash })

    return hash
  }
}

/** The name of the custom error a contract call reverted with, if it did. */
const revertName = (error: unknown): string | undefined => {
  if (!(error instanceof BaseError)) return undefined
  const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError)

  return reverted instanceof ContractFunctionRevertedError ? reverted.data?.errorName : undefined
}

const describe = (error: unknown): string => (error instanceof Error ? error.message.split('\n')[0] : String(error))
