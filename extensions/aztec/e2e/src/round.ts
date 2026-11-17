// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { createAztecNodeDebugClient } from '@aztec-labs/stdlib/interfaces/client'
import {
  CrispAztec,
  NATIONALITY_MODE,
  buildCast,
  connectAztec,
  encodeCustomParams,
  nationalityCommitment,
  registerOnL1Calldata,
  relayRegistrationOnL1,
  scopeOf,
  type AztecSession,
  type RoundRules,
  type ZKPassportProofParams,
} from '@crisp-e3/aztec'
import { CrispSDK, decodeTally, destroyBBApi, setCircuits } from '@crisp-e3/sdk'
import { loadCircuits } from '@crisp-e3/sdk/insecure-64'
import {
  createPublicClient,
  createWalletClient,
  encodeAbiParameters,
  pad,
  toHex,
  zeroAddress,
  zeroHash,
  http,
  parseAbi,
  parseEventLogs,
  type Address,
  type Hex,
  type PublicClient,
} from 'viem'
import { generatePrivateKey, privateKeyToAccount, sign } from 'viem/accounts'
import { foundry } from 'viem/chains'

import {
  AZTEC_NODE_URL,
  COMMITTEE_SIZE,
  E3_PARAM_SET,
  INSECURE_CONFIG_ID,
  L1_CHAIN_ID,
  L1_RPC_URL,
  SERVER_URL,
  WORK,
  ZKPASSPORT_DOMAIN,
  ZKPASSPORT_VALIDITY_SECONDS,
  accounts,
  envInt,
  paths,
} from './config'
import { isRunning, loadState, log, sleep, tail, waitFor } from './proc'
import type { Deployment } from './stack'
import { chainTime, domainHash, generateMockRegistrationProof, warpTo } from '../zkpassport/src/index'

const interfoldAbi = (JSON.parse(readFileSync(paths.interfoldArtifact, 'utf8')) as { abi: never[] }).abi
const programAbi = parseAbi([
  'function getRound(uint256 e3Id) view returns ((bytes32 paramsHash, uint256 numOptions, uint256 inputLimit, bool keyRelayed, bool rootSubmitted, uint256 inputRoot, uint256 numInputs))',
  'function decodeTally(uint256 e3Id) view returns (uint256[])',
  'function earliestVotingStart() view returns (uint256)',
  'event RoundConfigSent(uint256 indexed e3Id, bytes32 content)',
  'event CommitteeKeyRelayed(uint256 indexed e3Id, bytes32 committeePublicKey)',
  'event InputRootSubmitted(uint256 indexed e3Id, uint256 inputRoot, uint256 numInputs)',
])
const tokenAbi = parseAbi(['function mint(address to, uint256 amount)', 'function approve(address spender, uint256 amount) returns (bool)'])
const STAGES = ['None', 'Requested', 'CommitteeFinalized', 'KeyPublished', 'CiphertextReady', 'Complete', 'Failed'] as const

/** Votes: each voter's slot, the ballot (or a mask), and what it should add to the tally. */
const CREDITS = 10n
const NUM_OPTIONS = 2
const PLAN: { name: string; ballot: number[]; mask?: boolean }[] = [
  { name: 'voter1', ballot: [10, 0] },
  { name: 'voter2', ballot: [10, 0] },
  { name: 'voter3', ballot: [0, 10] },
  // Votes for option 1, then a mask is added to the slot. A mask adds a zero ballot on top of what the slot holds (the circuit
  // opens the slot's current ciphertext and adds zero), so it must leave this vote counted.
  { name: 'voter4', ballot: [0, 10], mask: true },
]
const EXPECTED_TALLY = [20n, 20n]

type Tx = { layer: 'L1' | 'L2'; what: string; hash: string }

/** What `startPump` hands back: stop it, or warp the clock while it is paused (the node serves one warp at a time). */
type Pump = { stop: () => Promise<void>; warpTo: (timestamp: number) => Promise<void> }

/** Keeps the idle local network producing blocks: L1→L2 messages are only included, and epochs proven, in blocks. */
const startPump = (intervalMs: number): Pump => {
  const debug = createAztecNodeDebugClient(AZTEC_NODE_URL)
  let stopped = false
  let tail: Promise<unknown> = Promise.resolve()
  // Pump ticks and warps are serialized through one chain: two warps in flight made the node reset the connection.
  const exclusive = <T>(work: () => Promise<T>): Promise<T> => {
    const result = tail.then(work, work)
    tail = result.catch(() => undefined)

    return result
  }
  const loop = (async () => {
    while (!stopped) {
      await exclusive(() => debug.warpL2TimeAtLeastBy(1)).catch((error) => log(`pump: ${String(error).split('\n')[0]}`))
      await sleep(intervalMs)
    }
  })()

  return {
    stop: async () => {
      stopped = true
      await loop
    },
    warpTo: async (timestamp) => {
      for (let attempt = 1; ; attempt++) {
        try {
          return await exclusive(() => warpTo(AZTEC_NODE_URL, timestamp))
        } catch (error) {
          if (attempt >= 5) throw error
          log(`warp to ${timestamp} failed (${String(error).split('\n')[0]}), retrying`)
          await sleep(3000)
        }
      }
    },
  }
}

const requireServices = (names: string[]): void => {
  const state = loadState()
  for (const name of names) {
    if (!isRunning(state, name)) throw new Error(`${name} is not running (run \`up\` first); log tail:\n${tail(name)}`)
  }
}

export type Path = 'aztec' | 'l1'

/** The two rounds: Aztec-path voters prove age and a nationality in a list, L1-path ones age and a nationality not in a list. */
const roundRules = async (path: Path, d: Deployment): Promise<RoundRules> => {
  const mode = path === 'l1' ? NATIONALITY_MODE.OUT : NATIONALITY_MODE.IN
  const countries = path === 'l1' ? ['PRK', 'IRN'] : ['ZKR', 'DEU']

  return {
    numOptions: BigInt(NUM_OPTIONS),
    credits: CREDITS,
    minAge: 18n,
    allowMockDocuments: true,
    registrar: path === 'l1' ? (d.registrar as Address) : zeroAddress,
    nationalityMode: mode,
    countries,
    // The Aztec contract verifies the proofs against this commitment; on the L1 path the registrar checks the list itself.
    nationalityCommitment: path === 'l1' ? 0n : await nationalityCommitment(mode, countries),
  }
}

/** What the ZKPassport mock verifier of `MockZKPassport.sol` reads from a proof (the registrar's own checks run for real). */
type MockL1Proof = { identifier: Hex; age: bigint; nationality: string; boundTo: Address | undefined }

const l1Identifier = (e3Id: bigint, index: number): Hex => pad(toHex(e3Id * 1000n + BigInt(index)), { size: 32 })

const mockL1Proof = (slot: Address, mock: MockL1Proof): ZKPassportProofParams => ({
  version: zeroHash,
  proofVerificationData: { vkeyHash: zeroHash, proof: '0x01', publicInputs: [mock.identifier] },
  committedInputs: encodeAbiParameters(
    [{ type: 'address' }, { type: 'uint256' }, { type: 'uint256' }, { type: 'string' }],
    [mock.boundTo ?? slot, BigInt(L1_CHAIN_ID), mock.age, mock.nationality],
  ),
  serviceConfig: { validityPeriodInSeconds: ZKPASSPORT_VALIDITY_SECONDS, domain: ZKPASSPORT_DOMAIN, scope: '', devMode: true },
})

/** Runs both paths, one round each, against the running stack (`which` runs one of them). */
export const round = async (which?: Path): Promise<void> => {
  const state = loadState()
  if (!state.deployment) throw new Error('No deployment: run `up` first')
  requireServices(['ciphernodes', 'program', 'server', 'keeper', 'randomness'])
  try {
    setCircuits(await loadCircuits())
    for (const path of which ? [which] : (['aztec', 'l1'] as const)) await roundOnPath(path)
  } finally {
    await Promise.resolve(destroyBBApi()).catch(() => undefined)
  }
}

const roundOnPath = async (path: Path): Promise<void> => {
  const state = loadState()
  const d = state.deployment as Deployment

  const txs: Tx[] = []
  const t0 = Date.now()
  const stamp = () => `+${Math.round((Date.now() - t0) / 1000)}s`
  const l1 = createPublicClient({ chain: foundry, transport: http(L1_RPC_URL) })
  const interfold = { address: d.interfold, abi: interfoldAbi } as const
  const program = { address: d.program, abi: programAbi } as const
  const debugging = () => requireServices(['ciphernodes', 'program', 'server', 'keeper'])
  const pump = startPump(envInt('CRISP_E2E_PUMP_MS', 8000))
  const sessions: AztecSession[] = []
  log(`==== round on the ${path === 'l1' ? 'L1 (ZKPassport registrar, relayed by the CRISP server)' : 'Aztec'} registration path ====`)

  try {
    const aztecChainNow = async () => {
      const probe = await connectAztec(AZTEC_NODE_URL)
      try {
        return await chainTime(probe.node)
      } finally {
        await probe.stop()
      }
    }

    // ---- 1. The request: one transaction by the creator ----
    const rules = await roundRules(path, d)
    const creator = createWalletClient({ account: accounts.creator.account, chain: foundry, transport: http(L1_RPC_URL) })
    const deployer = createWalletClient({ account: accounts.deployer.account, chain: foundry, transport: http(L1_RPC_URL) })
    const votingSeconds = envInt('CRISP_E2E_VOTING_SECONDS', 3600)
    // Voting cannot start before a worst-case key setup has fit: the program rejects an earlier start.
    const inputStart = ((await l1.readContract({ ...program, functionName: 'earliestVotingStart' })) as bigint) + 300n
    const inputEnd = inputStart + BigInt(votingSeconds)
    const computeProviderParams = (() => {
      // bincode of {name: "OpenVM", parallel: false, batch_size: 4}: u64 LE length, bytes, bool, u32 LE.
      const name = Buffer.from('OpenVM')
      const head = Buffer.alloc(8)
      head.writeBigUInt64LE(BigInt(name.length))
      const batch = Buffer.alloc(4)
      batch.writeUInt32LE(4)

      return `0x${Buffer.concat([head, name, Buffer.from([0]), batch]).toString('hex')}` as Hex
    })()
    const customParams = encodeCustomParams(rules)
    const requestParams = {
      committeeSize: COMMITTEE_SIZE,
      inputWindow: [inputStart, inputEnd] as [bigint, bigint],
      e3Program: d.program,
      paramSet: E3_PARAM_SET,
      computeProviderParams,
      customParams,
      expectedFeeToken: d.feeToken,
      expectedCryptoConfigId: INSECURE_CONFIG_ID,
      maxFee: 2n ** 255n,
    }
    const fee = (await l1.readContract({ ...interfold, functionName: 'getE3Quote', args: [requestParams] })) as bigint
    requestParams.maxFee = fee
    log(`request: ${NUM_OPTIONS} options, ${CREDITS} credits, window ${inputStart}..${inputEnd} (${votingSeconds}s), fee ${fee}`)
    for (const [wallet, what, call] of [
      [deployer, 'mint fee token', { address: d.feeToken, abi: tokenAbi, functionName: 'mint', args: [accounts.creator.address, fee * 2n] }],
    ] as const) {
      const hash = await wallet.writeContract({ ...call, account: wallet.account })
      await l1.waitForTransactionReceipt({ hash })
      txs.push({ layer: 'L1', what, hash })
    }
    const approveHash = await creator.writeContract({
      address: d.feeToken,
      abi: tokenAbi,
      functionName: 'approve',
      args: [d.interfold, fee],
      account: creator.account,
    })
    await l1.waitForTransactionReceipt({ hash: approveHash })
    txs.push({ layer: 'L1', what: 'creator approves the fee', hash: approveHash })

    const requestHash = await creator.writeContract({ ...interfold, functionName: 'request', args: [requestParams], account: creator.account })
    const requestReceipt = await l1.waitForTransactionReceipt({ hash: requestHash })
    if (requestReceipt.status !== 'success') throw new Error('Interfold.request reverted')
    txs.push({ layer: 'L1', what: 'Interfold.request (the only creator tx)', hash: requestHash })
    const [requested] = parseEventLogs({ abi: interfoldAbi, eventName: 'E3Requested', logs: requestReceipt.logs })
    const e3Id = (requested as unknown as { args: { e3Id: bigint } }).args.e3Id
    log(`${stamp()} E3 ${e3Id} requested (tx ${requestHash}, block ${requestReceipt.blockNumber})`)

    // ---- 2. DKG: stage KeyPublished ----
    const stage = async () => STAGES[Number(await l1.readContract({ ...interfold, functionName: 'getE3Stage', args: [e3Id] }))]
    let lastStage = ''
    await waitFor(
      'the committee key (stage KeyPublished)',
      async () => {
        debugging()
        const now = await stage()
        if (now !== lastStage) {
          log(`${stamp()} E3 ${e3Id} stage: ${now}`)
          lastStage = now
        }
        if (now === 'Failed') throw new Error(`E3 ${e3Id} failed during the key setup:\n${tail('ciphernodes', 40)}`)

        return now === 'KeyPublished'
      },
      { timeoutMs: envInt('CRISP_E2E_DKG_TIMEOUT_S', 1200) * 1000, intervalMs: 3000 },
    )

    // ---- 3. The keeper opens the round and relays the key on L2 ----
    const watcher = await connectAztec(AZTEC_NODE_URL)
    sessions.push(watcher)
    const crispWatcher = await CrispAztec.connect(watcher, d.aztecContract)
    const opened = await waitFor(
      'the round to be opened on Aztec by the keeper',
      async () => {
        debugging()

        return crispWatcher.getRound(e3Id)
      },
      { timeoutMs: 900_000, intervalMs: 5000 },
    )
    log(`${stamp()} round open on Aztec: window ${opened.inputStart}..${opened.inputEnd}, limit ${opened.inputLimit}, scope ${opened.scopeHash}`)
    if (opened.l1Registration !== (path === 'l1') || opened.nationalityMode !== rules.nationalityMode || opened.nationalityCommitment !== rules.nationalityCommitment) {
      throw new Error(`The round opened on Aztec with other rules than requested: ${JSON.stringify(opened, (_, v) => (typeof v === 'bigint' ? v.toString() : v))}`)
    }
    const committeeKeyCommitment = await waitFor(
      'the committee key on Aztec (KeyPublished)',
      async () => {
        debugging()

        return crispWatcher.getCommitteeKey(e3Id)
      },
      { timeoutMs: 900_000, intervalMs: 5000 },
    )
    log(`${stamp()} committee key published on Aztec: ${committeeKeyCommitment}`)

    const sdk = new CrispSDK(SERVER_URL)
    const committeePublicKey = await waitFor('the committee public key from the CRISP server', async () => sdk.getRoundPublicKey(e3Id), {
      timeoutMs: 120_000,
      intervalMs: 3000,
    })

    // ---- 4. Registration ----
    const voters = PLAN.map((entry) => ({ ...entry, slotKey: generatePrivateKey() }))
    const slotOf = (voter: (typeof voters)[number]) => privateKeyToAccount(voter.slotKey).address
    const clients: CrispAztec[] = []
    for (const [index, voter] of voters.entries()) {
      const session = await connectAztec(AZTEC_NODE_URL)
      sessions.push(session)
      clients.push(await CrispAztec.connect(session, d.aztecContract))
      if (path === 'l1') continue
      // Aztec path: a real mock-document proof (age and nationality) bound to this Aztec account and this round's scope.
      const started = Date.now()
      const proof = await generateMockRegistrationProof({
        aztecAddress: session.address.toString(),
        domain: domainHash(ZKPASSPORT_DOMAIN),
        scope: scopeOf(L1_CHAIN_ID, d.program, e3Id),
        minAge: Number(rules.minAge),
        nationality: { mode: rules.nationalityMode as 1 | 2, countries: rules.countries },
        now: await chainTime(session.node),
        documentNumber: `E2E${e3Id}${index}`.padEnd(9, '0').slice(-9),
      })
      log(`${stamp()} ${voter.name}: ${proof.circuit} proof in ${((Date.now() - started) / 1000).toFixed(0)}s`)
      const sent = await clients[index].register({ e3Id, slot: slotOf(voter), proof })
      txs.push({ layer: 'L2', what: `${voter.name} register (slot ${slotOf(voter)})`, hash: sent.txHash })
      log(`${stamp()} ${voter.name}: registered, tx ${sent.txHash} (block ${sent.blockNumber})`)
    }
    if (path === 'l1') {
      // L1 path: no Aztec account, no wallet: the proof is bound to the slot and the CRISP server relays it to the registrar.
      const registerThroughServer = async (slot: Address, mock: MockL1Proof) => {
        const calldata = registerOnL1Calldata({ e3Id, slot, params: mockL1Proof(slot, mock), countries: rules.countries })
        const { txHash } = await relayRegistrationOnL1(SERVER_URL, calldata)
        const receipt = await l1.waitForTransactionReceipt({ hash: txHash })
        if (receipt.status !== 'success') throw new Error(`The registration ${txHash} reverted on L1`)

        return txHash
      }
      const good = (index: number): MockL1Proof => ({ identifier: l1Identifier(e3Id, index), age: 30n, nationality: 'ZKR', boundTo: undefined })
      // The server simulates a registration first and answers 400 with the registrar's error: the rules are enforced on L1.
      const slotOne = slotOf(voters[0])
      const refused = async (control: string, expected: string, mock: MockL1Proof, slot = slotOne) => {
        try {
          await registerThroughServer(slot, mock)
        } catch (error) {
          if (!String(error).includes(expected)) throw new Error(`Control "${control}" failed with ${String(error)}, expected ${expected}`)
          log(`${stamp()} control "${control}" refused: ${expected}`)

          return
        }
        throw new Error(`Control "${control}" was accepted`)
      }
      await refused('a nationality on the excluded list', 'NationalityNotProven', { ...good(90), nationality: 'PRK' })
      await refused('a voter under the minimum age', 'AgeNotProven', { ...good(91), age: 17n })
      await refused('a proof bound to another slot', 'WrongBinding', { ...good(92), boundTo: slotOf(voters[1]) })
      for (const [index, voter] of voters.entries()) {
        const hash = await registerThroughServer(slotOf(voter), good(index))
        txs.push({ layer: 'L1', what: `${voter.name} registration (relayed by the server, slot ${slotOf(voter)})`, hash })
        log(`${stamp()} ${voter.name}: registered on L1 through the server, tx ${hash}`)
      }
      await refused('a document that already registered', 'DocumentAlreadyRegistered', good(0), slotOf(voters[1]))
    }
    // L1 path: the keeper carries each MEMBER message to `add_member_from_l1`; the census is complete when all are in.
    const census = await waitFor(
      path === 'l1' ? 'the keeper to add every L1 registration to the census' : 'the census',
      async () => {
        debugging()
        const current = await crispWatcher.getCensus(e3Id)

        return current.leaves.length === voters.length ? current : undefined
      },
      { timeoutMs: envInt('CRISP_E2E_MEMBERS_TIMEOUT_S', 1200) * 1000, intervalMs: 5000 },
    )
    log(`${stamp()} census: ${census.leaves.length} members`)

    // The input window opens after the worst-case key setup the program reserves; the key is in, so skip the wait.
    const beforeVoting = await aztecChainNow()
    if (BigInt(beforeVoting) < opened.inputStart) {
      log(`${stamp()} warping the network clock ${Number(opened.inputStart) - beforeVoting}s to the start of the input window`)
      await pump.warpTo(Number(opened.inputStart))
    }

    // ---- 5. Votes (and one mask) ----
    const castOne = async (index: number, ballot: number[] | undefined, label: string) => {
      const voter = voters[index]
      const started = Date.now()
      const args = await withRetries(`${voter.name} ${label}: building the ballot proof`, () => buildCast({
        serverUrl: SERVER_URL,
        program: d.program,
        l1ChainId: L1_CHAIN_ID,
        e3Id,
        slot: slotOf(voter),
        credits: CREDITS,
        numOptions: NUM_OPTIONS,
        census,
        committeePublicKey,
        committeeKeyCommitment,
        availabilitySigner: d.serverSigner as Address,
        ballot: ballot ? { vote: ballot, sign: async (digest) => signDigest(voter.slotKey, digest) } : undefined,
        onProgress: (progress) => log(`${stamp()} ${voter.name}: ${JSON.stringify(progress)}`),
      }))
      const sent = await clients[index].cast(args)
      txs.push({ layer: 'L2', what: `${voter.name} ${label}`, hash: sent.txHash })
      log(`${stamp()} ${voter.name}: ${label} in ${((Date.now() - started) / 1000).toFixed(0)}s, tx ${sent.txHash} (block ${sent.blockNumber})`)
    }
    for (const [index, voter] of voters.entries()) await castOne(index, voter.ballot, `cast [${voter.ballot}]`)
    for (const [index, voter] of voters.entries()) {
      if (!voter.mask) continue
      // The server learns a ballot from the Aztec log; a mask replaces the slot's head, so the server must have it.
      await waitFor(`the server to index ${voter.name}'s ballot`, async () => sdk.getPreviousCiphertext(e3Id, slotOf(voter)), {
        // The server reads only proven epochs of Aztec, so this waits for the epoch proof of the ballot's block.
        timeoutMs: envInt('CRISP_E2E_INDEX_TIMEOUT_S', 1200) * 1000,
        intervalMs: 3000,
      })
      await castOne(index, undefined, 'mask')
    }
    const inputs = await crispWatcher.getInputCount(e3Id)
    log(`${stamp()} ${inputs} inputs on Aztec`)
    if (inputs !== voters.length + voters.filter((v) => v.mask).length) throw new Error(`Expected ${voters.length + 1} inputs, the contract has ${inputs}`)

    // ---- 6. Close the window; the keeper closes the round and submits the root on L1 ----
    const now = await aztecChainNow()
    if (BigInt(now) < opened.inputEnd) {
      log(`${stamp()} warping the network clock ${Number(opened.inputEnd) - now}s to the end of the input window`)
      await pump.warpTo(Number(opened.inputEnd) + 1)
    }
    const submitted = await waitFor(
      'the keeper to close the round and submit the input root on L1',
      async () => {
        debugging()
        const state1 = await l1.readContract({ ...program, functionName: 'getRound', args: [e3Id] })

        return state1.rootSubmitted ? state1 : undefined
      },
      { timeoutMs: envInt('CRISP_E2E_ROOT_TIMEOUT_S', 1500) * 1000, intervalMs: 5000 },
    )
    log(`${stamp()} input root on L1: ${submitted.inputRoot} (${submitted.numInputs} inputs)`)
    const rootLogs = await l1.getContractEvents({ ...program, eventName: 'InputRootSubmitted', args: { e3Id }, fromBlock: BigInt(d.programBlock) })
    for (const entry of rootLogs) txs.push({ layer: 'L1', what: 'CRISPAztecProgram.submitInputRoot (keeper)', hash: entry.transactionHash })

    // ---- 7. Compute, decryption, tally ----
    lastStage = ''
    await waitFor(
      'the plaintext (stage Complete)',
      async () => {
        debugging()
        const now2 = await stage()
        if (now2 !== lastStage) {
          log(`${stamp()} E3 ${e3Id} stage: ${now2}`)
          lastStage = now2
        }
        if (now2 === 'Failed') throw new Error(`E3 ${e3Id} failed:\n${tail('server', 40)}`)

        return now2 === 'Complete'
      },
      { timeoutMs: envInt('CRISP_E2E_COMPUTE_TIMEOUT_S', 1800) * 1000, intervalMs: 5000 },
    )
    const tally = (await l1.readContract({ ...program, functionName: 'decodeTally', args: [e3Id] })) as bigint[]
    log(`${stamp()} decoded tally on L1: [${tally}]`)
    const serverResult = await sdk.getRoundResult(e3Id).catch((error) => ({ error: String(error) }))
    log(`server result: ${JSON.stringify(serverResult, (_, v) => (typeof v === 'bigint' ? v.toString() : v)).slice(0, 400)}`)

    const report = {
      path,
      e3Id: e3Id.toString(),
      rules,
      expectedTally: EXPECTED_TALLY.map(String),
      tally: tally.map(String),
      decodedWithSdk: decodeTally(await sdkPlaintext(l1, interfold, e3Id), NUM_OPTIONS).map(String),
      serverResult,
      transactions: txs,
      seconds: Math.round((Date.now() - t0) / 1000),
    }
    const reportFile = join(WORK, `report-${path}.json`)
    writeFileSync(reportFile, `${JSON.stringify(report, (_, v) => (typeof v === 'bigint' ? v.toString() : v), 2)}\n`)
    if (tally.length !== EXPECTED_TALLY.length || tally.some((value, i) => value !== EXPECTED_TALLY[i])) {
      throw new Error(`Tally mismatch: expected [${EXPECTED_TALLY}], decoded [${tally}]`)
    }
    log(`PASS (${path} path): tally [${tally}] equals the cast votes [${EXPECTED_TALLY}] in ${report.seconds}s; report at ${reportFile}`)
    for (const tx of txs) log(`  ${tx.layer} ${tx.hash} ${tx.what}`)
  } finally {
    await pump.stop()
    for (const session of sessions) await Promise.resolve(session.stop()).catch(() => undefined)
  }
}

/** The proving stack downloads the BN254 SRS (about 128 MiB) from the network for each proof; a reset connection is worth a retry. */
const withRetries = async <T>(what: string, work: () => Promise<T>, attempts = 3): Promise<T> => {
  for (let attempt = 1; ; attempt++) {
    try {
      return await work()
    } catch (error) {
      if (attempt >= attempts) throw error
      log(`${what} failed (${String(error).split('\n')[0]}; cause: ${String((error as { cause?: unknown }).cause)}), attempt ${attempt}/${attempts}`)
      await sleep(5000)
    }
  }
}

const sdkPlaintext = async (l1: PublicClient, interfold: { address: Address; abi: never[] }, e3Id: bigint): Promise<Hex> => {
  const e3 = (await l1.readContract({ ...interfold, functionName: 'getE3', args: [e3Id] })) as { plaintextOutput: Hex }

  return e3.plaintextOutput
}

/** Sign an EIP-712 digest raw (no EIP-191 prefix) with the slot key: the 65-byte `r ‖ s ‖ v` `buildCast` expects. */
const signDigest = (key: Hex, digest: Hex): Promise<Hex> => sign({ hash: digest, privateKey: key, to: 'hex' })
