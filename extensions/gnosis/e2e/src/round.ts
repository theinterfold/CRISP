// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  E3_STAGE,
  OPTION,
  buildRequest,
  castBallot,
  castMask,
  claimFaucet,
  crispDemoTokenAbi,
  crispGnosisProgramAbi,
  crispGnosisVotingAbi,
  crispGovernanceModuleAbi,
  delayAbi,
  e3IdOf,
  getConfig,
  getProposalStatus,
  interfoldAbi,
  packBatch,
  quoteFee,
  requestRound,
  roundIdOf,
} from '@crisp-e3/gnosis'
import { destroyBBApi, setCircuits } from '@crisp-e3/sdk'
import { loadCircuits } from '@crisp-e3/sdk/insecure-64'
import { createPublicClient, createWalletClient, encodeFunctionData, http, parseAbi, type Account, type Address, type Hex } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { foundry } from 'viem/chains'

import { CHAIN_ID, COMMITTEE_SIZE, E3_PARAM_SET, INSECURE_CONFIG_ID, METADATA_URL, RPC_URL, SERVER_URL, WORK, accounts, envInt, paths } from './config'
import { isRunning, loadState, log, sleep, tail, waitFor } from './proc'
import { rpc, type Deployment } from './stack'

const feeTokenAbi = parseAbi(['function mint(address to, uint256 amount)'])
const STAGES = ['None', 'Requested', 'CommitteeFinalized', 'KeyPublished', 'CiphertextReady', 'Complete', 'Failed'] as const

const requireServices = (names: string[]): void => {
  const state = loadState()
  for (const name of names) {
    if (!isRunning(state, name)) throw new Error(`${name} is not running (run \`up\` first); log tail:\n${tail(name)}`)
  }
}

/** Runs one proposal against the running stack. */
export const round = async (): Promise<void> => {
  const state = loadState()
  if (!state.deployment) throw new Error('No deployment: run `up` first')
  requireServices(['anvil', 'ciphernodes', 'program', 'server', 'keeper', 'relayer', 'metadata', 'randomness'])
  try {
    setCircuits(await loadCircuits())
    await runRound(state.deployment as Deployment)
  } finally {
    await Promise.resolve(destroyBBApi()).catch(() => undefined)
  }
}

const runRound = async (d: Deployment): Promise<void> => {
  const t0 = Date.now()
  const stamp = () => `+${Math.round((Date.now() - t0) / 1000)}s`
  const services = () => requireServices(['anvil', 'ciphernodes', 'program', 'server', 'keeper', 'relayer'])
  const sepolia = createPublicClient({ chain: foundry, transport: http(RPC_URL) })
  // One anvil plays both chains, so the two clients are the same: the code below still keeps them apart.
  const chiado = sepolia
  const wallet = (account: Account) => createWalletClient({ account, chain: foundry, transport: http(RPC_URL) })
  const deployer = wallet(accounts.deployer.account)
  const proposer = wallet(accounts.proposer.account)
  const send = async (client: ReturnType<typeof wallet>, call: Parameters<typeof client.writeContract>[0], what: string) => {
    const hash = await client.writeContract(call)
    const receipt = await sepolia.waitForTransactionReceipt({ hash })
    if (receipt.status !== 'success') throw new Error(`${what} reverted in ${hash}`)
    log(`${stamp()} ${what}`)

    return hash
  }
  const now = async () => (await sepolia.getBlock({ blockTag: 'latest' })).timestamp
  const warpTo = async (timestamp: bigint) => {
    const delta = timestamp - (await now())
    if (delta > 0n) await rpc('evm_increaseTime', [Number(delta)])
    await rpc('evm_mine')
  }
  const balanceOf = (who: Address) => chiado.readContract({ address: d.token, abi: crispDemoTokenAbi, functionName: 'balanceOf', args: [who] })

  const config = await getConfig(SERVER_URL)
  if (config.voting_address.toLowerCase() !== d.voting.toLowerCase() || config.chain_id !== CHAIN_ID) {
    throw new Error(`The server is wired to another stack: ${JSON.stringify(config)}`)
  }
  log(`==== proposal on a local anvil (${config.chain_id}) ====`)

  // ---- 0. Setup the harness owns: the proposer allowlist, the faucet, the fee token ----
  if (!(await sepolia.readContract({ address: d.program, abi: crispGnosisProgramAbi, functionName: 'isProposer', args: [accounts.proposer.address] }))) {
    await send(deployer, { address: d.program, abi: crispGnosisProgramAbi, functionName: 'setProposer', args: [accounts.proposer.address, true] }, 'allow the proposer')
  }
  if ((await chiado.readContract({ address: d.token, abi: crispDemoTokenAbi, functionName: 'faucet' })).toLowerCase() !== accounts.faucet.address.toLowerCase()) {
    await send(deployer, { address: d.token, abi: crispDemoTokenAbi, functionName: 'setFaucet', args: [accounts.faucet.address] }, 'set the faucet')
  }

  // ---- 1. Voters claim tokens from the server's faucet: no gas, and delegated to themselves ----
  // The server rate-limits claims per client: CRISP_E2E_DIRECT_FAUCET=1 mints with the faucet key instead, for reruns.
  const voters = [OPTION.FOR, OPTION.FOR, OPTION.AGAINST].map((choice, index) => {
    const account = privateKeyToAccount(generatePrivateKey())

    return { name: `voter${index + 1}`, choice, account, wallet: wallet(account) }
  })
  const direct = process.env.CRISP_E2E_DIRECT_FAUCET === '1'
  for (const voter of voters) {
    const { txHash, amount } = direct
      ? {
          txHash: await wallet(accounts.faucet.account).writeContract({ address: d.token, abi: crispDemoTokenAbi, functionName: 'faucetMint', args: [voter.account.address] }),
          amount: await chiado.readContract({ address: d.token, abi: crispDemoTokenAbi, functionName: 'faucetAmount' }),
        }
      : await claimFaucet(SERVER_URL, voter.account.address)
    await sepolia.waitForTransactionReceipt({ hash: txHash })
    const votes = await chiado.readContract({ address: d.token, abi: crispDemoTokenAbi, functionName: 'getVotes', args: [voter.account.address] })
    if (votes !== amount) throw new Error(`${voter.name} holds ${amount} but has ${votes} votes: the faucet did not delegate`)
    log(`${stamp()} ${voter.name} ${voter.account.address} claimed ${amount}`)
  }
  // The snapshot is the request time minus one: the checkpoints must be older than that.
  await sleep(3000)

  // ---- 2. The proposal: move tokens from the Safe, bound by hash ----
  const safeBefore = await balanceOf(d.safe)
  const transferred = safeBefore / 10n
  if (transferred === 0n) throw new Error('The Safe holds no tokens: nothing to propose')
  const { packed, proposalHash } = packBatch([
    {
      to: d.token,
      data: encodeFunctionData({ abi: crispDemoTokenAbi, functionName: 'transfer', args: [accounts.recipient.address, transferred] }),
    },
  ])
  const metadataCid = `e2e-${Date.now()}`
  writeFileSync(
    join(paths.metadataDir, `${metadataCid}.json`),
    JSON.stringify({ schema: 'crisp-cow/proposal@1', title: 'E2E', description: 'Move tokens out of the Safe', packedTransactions: packed }),
  )

  const votingSeconds = envInt('CRISP_E2E_VOTING_SECONDS', 3600)
  const inputStart = (await sepolia.readContract({ address: d.program, abi: crispGnosisProgramAbi, functionName: 'earliestVotingStart' })) + 120n
  const request = buildRequest({
    program: d.program,
    inputStart,
    inputEnd: inputStart + BigInt(votingSeconds),
    proposalHash,
    metadataCid,
    feeToken: d.feeToken,
    cryptoConfigId: INSECURE_CONFIG_ID,
    maxFee: 2n ** 255n,
    committeeSize: COMMITTEE_SIZE,
    paramSet: E3_PARAM_SET,
  })
  const fee = await quoteFee(sepolia, d.interfold, request)
  request.maxFee = fee
  await send(deployer, { address: d.feeToken, abi: feeTokenAbi, functionName: 'mint', args: [accounts.proposer.address, fee * 2n] }, 'mint the fee token')
  const { e3Id, txHash } = await requestRound(proposer, sepolia, d.interfold, request)
  const roundId = roundIdOf(e3Id)
  if (e3Id !== e3IdOf(d.interfold, roundId)) throw new Error('The e3Id does not carry the Interfold address')
  log(`${stamp()} E3 ${e3Id} requested in ${txHash}: window ${request.inputWindow.join('..')}, fee ${fee}`)

  // ---- 3. ROUND over the AMB: the relayer delivers it ----
  const opened = await waitFor(
    'the round to open on the voting side (the ROUND message)',
    async () => {
      services()
      const r = await chiado.readContract({ address: d.voting, abi: crispGnosisVotingAbi, functionName: 'roundOf', args: [roundId] })

      return r.inputEnd !== 0n && r
    },
    { timeoutMs: 120_000, intervalMs: 2000 },
  )
  if (opened.proposalHash !== proposalHash || opened.metadataCid !== metadataCid || opened.requester.toLowerCase() !== accounts.proposer.address.toLowerCase()) {
    throw new Error(`The round opened with other values than requested: ${JSON.stringify(opened, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}`)
  }
  log(`${stamp()} round open: window ${opened.inputStart}..${opened.inputEnd}, snapshot ${opened.snapshot}, divisor ${opened.divisor}`)

  // ---- 4. DKG, then KEY: the keeper relays it, the relayer delivers it ----
  let lastStage = ''
  let lastPhase = ''
  await waitFor(
    'the committee key (stage KeyPublished)',
    async () => {
      services()
      const stage = STAGES[Number(await sepolia.readContract({ address: d.interfold, abi: interfoldAbi, functionName: 'getE3Stage', args: [e3Id] }))]
      if (stage !== lastStage) {
        log(`${stamp()} E3 ${e3Id} stage: ${stage}`)
        lastStage = stage
      }
      if (stage === 'Failed') throw new Error(`E3 ${e3Id} failed during the key setup:\n${tail('ciphernodes', 40)}`)

      return stage === 'KeyPublished'
    },
    { timeoutMs: envInt('CRISP_E2E_DKG_TIMEOUT_S', 1200) * 1000, intervalMs: 3000 },
  )
  await waitFor(
    'the committee key on the voting side (the KEY message)',
    async () => {
      services()

      return (await getProposalStatus({ sepolia, chiado, interfold: d.interfold, program: d.program, voting: d.voting, module: d.module, e3Id })).phase !== 'RoundOpen'
    },
    { timeoutMs: 120_000, intervalMs: 2000 },
  )
  log(`${stamp()} committee key delivered to the voting side`)

  // The window starts a worst-case key setup after the request: move the chain clock instead of waiting.
  await warpTo(inputStart)

  // ---- 5. Votes: two For, one Against, then a mask on the Against voter's slot ----
  const weights: bigint[] = []
  for (const voter of voters) {
    const weight = await chiado.readContract({ address: d.voting, abi: crispGnosisVotingAbi, functionName: 'votingPowerOf', args: [e3Id, voter.account.address] })
    if (weight === 0n) throw new Error(`${voter.name} has no voting power in the round: its tokens are below the divisor ${opened.divisor}`)
    weights.push(weight)
  }
  const cast = { serverUrl: SERVER_URL, e3Id, voting: d.voting, chainId: config.chain_id, chiado }
  let numInputs = 0n
  const expectInput = async (what: string, txHash: Hex) => {
    numInputs += 1n
    const r = await chiado.readContract({ address: d.voting, abi: crispGnosisVotingAbi, functionName: 'roundOf', args: [roundId] })
    if (r.numInputs !== numInputs) throw new Error(`After ${what} the round has ${r.numInputs} inputs, expected ${numInputs}`)
    // The real Honk verifier runs in publishInput: its gas is what a Gnosis block has to fit.
    const { gasUsed } = await chiado.getTransactionReceipt({ hash: txHash })
    log(`${stamp()} ${what}: publishInput used ${gasUsed} gas`)
  }
  for (const voter of voters) {
    const { result } = await castBallot({ ...cast, wallet: voter.wallet, choice: voter.choice, onProgress: (p) => log(`  ${voter.name}: proof ${p.index + 1}/${p.total} ${p.stage}`) })
    if (result.status !== 'success') throw new Error(`The server did not relay ${voter.name}'s ballot: ${JSON.stringify(result)}`)
    await expectInput(`${voter.name}'s ballot`, result.txHash)
    log(`${stamp()} ${voter.name} voted ${voter.choice === OPTION.FOR ? 'For' : 'Against'} with weight ${weights[voters.indexOf(voter)]} (tx ${result.txHash})`)
  }
  // A mask adds a zero ballot on top of what the slot holds: it must leave the Against vote counted.
  const maskTarget = voters[2]
  const mask = await castMask({ ...cast, slot: maskTarget.account.address, onProgress: (p) => log(`  mask: proof ${p.index + 1}/${p.total} ${p.stage}`) })
  if (mask.result.status !== 'success') throw new Error(`The server did not relay the mask: ${JSON.stringify(mask.result)}`)
  await expectInput('the mask', mask.result.txHash)
  log(`${stamp()} mask added to ${maskTarget.name}'s slot`)

  // ---- 6. Close, ROOT over the AMB (the keeper carries it), compute, decrypt, RESULT ----
  await warpTo(inputStart + BigInt(votingSeconds) + 1n)
  const resolved = await waitFor(
    'the tally on the voting side (close, ROOT, compute, decrypt, RESULT)',
    async () => {
      services()
      const status = await getProposalStatus({ sepolia, chiado, interfold: d.interfold, program: d.program, voting: d.voting, module: d.module, e3Id })
      if (status.phase !== lastPhase) {
        log(`${stamp()} proposal phase: ${status.phase} (E3 stage ${STAGES[status.stage]})`)
        lastPhase = status.phase
      }
      if (status.stage === E3_STAGE.Failed) throw new Error(`E3 ${e3Id} failed:\n${tail('server', 40)}`)

      return status.result.resolved && status.result
    },
    { timeoutMs: envInt('CRISP_E2E_RESULT_TIMEOUT_S', 1800) * 1000, intervalMs: 3000 },
  )
  const expectedTally = [weights[0] + weights[1], weights[2], 0n]
  if (resolved.tally.join() !== expectedTally.join()) throw new Error(`The tally is [${resolved.tally}], expected [${expectedTally}]`)
  log(`${stamp()} tally [For, Against, Abstain] = [${resolved.tally}] as expected`)

  // ---- 7. The module queues the batch (the keeper executes the passed proposal), the Delay releases it ----
  const executedByModule = await waitFor(
    'the module to queue the proposal in the Delay',
    async () => {
      services()

      return chiado.readContract({ address: d.module, abi: crispGovernanceModuleAbi, functionName: 'executed', args: [roundId] })
    },
    { timeoutMs: 300_000, intervalMs: 3000 },
  )
  log(`${stamp()} proposal queued in the Delay (${executedByModule})`)
  if ((await balanceOf(d.safe)) !== safeBefore) throw new Error('The Safe moved tokens before the Delay released the batch')

  const cooldown = await chiado.readContract({ address: d.delay, abi: delayAbi, functionName: 'txCooldown' })
  await warpTo((await now()) + cooldown + 1n)
  await waitFor(
    "the Safe's token balance to change (the keeper runs the Delay's queue)",
    async () => {
      services()

      return (await balanceOf(d.safe)) !== safeBefore
    },
    { timeoutMs: 300_000, intervalMs: 3000 },
  )

  const safeAfter = await balanceOf(d.safe)
  const recipient = await balanceOf(accounts.recipient.address)
  if (safeBefore - safeAfter !== transferred) throw new Error(`The Safe lost ${safeBefore - safeAfter}, expected ${transferred}`)
  if (recipient !== transferred) throw new Error(`The recipient holds ${recipient}, expected ${transferred}`)
  const status = await getProposalStatus({ sepolia, chiado, interfold: d.interfold, program: d.program, voting: d.voting, module: d.module, e3Id })
  if (status.phase !== 'Executed') throw new Error(`The proposal is ${status.phase}, expected Executed`)
  log(`${stamp()} PASS: the Safe's balance fell by the batch amount ${transferred} (${safeBefore} → ${safeAfter})`)

  writeFileSync(
    join(WORK, 'report.json'),
    JSON.stringify({ e3Id, tally: resolved.tally, transferred, safeBefore, safeAfter, proposalHash, metadataCid, metadataUrl: `${METADATA_URL}/${metadataCid}` }, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2),
  )
}
