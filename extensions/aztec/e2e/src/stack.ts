// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { arch, homedir, platform } from 'node:os'
import { join } from 'node:path'

import { connectAztec, deployCrispAztec, getBaseVerificationKeys, domainSeparator } from '@crisp-e3/aztec'
import { destroyBBApi, setCircuits } from '@crisp-e3/sdk'
import { loadCircuits } from '@crisp-e3/sdk/insecure-64'
import { getAddress, type Address } from 'viem'

import {
  AZTEC_NODE_URL,
  COMMITTEE_SIZE,
  E3_PARAM_SET,
  L1_CHAIN_ID,
  L1_RPC_URL,
  L1_WS_URL,
  MNEMONIC,
  REPO,
  SERVER_URL,
  WORK,
  ZKPASSPORT_DOMAIN,
  ZKPASSPORT_VALIDITY_SECONDS,
  accounts,
  ciphernodes,
  env,
  paths,
  ports,
} from './config'
import { type State, isRunning, loadState, log, portOpen, run, saveState, sleep, startDaemon, stopDaemon, tail, waitFor, workDir } from './proc'
import {
  CIRCUITS_VERSION,
  LOCAL_NETWORK_REGISTRY_ADDRESS,
  circuitsVersionField,
  connectRegistryContext,
  domainHash,
  seedLocalRegistry,
} from '../zkpassport/src/index'

/** Whether the ciphernodes skip proof aggregation (needs an interfold binary built with `test-only-skip-proof-aggregation`). */
export const skipProofAggregation = () => env('CRISP_E2E_SKIP_PROOF_AGGREGATION', 'false') === 'true'

/** Repo files the deploy scripts rewrite. They are restored (or removed) by `down`. */
const TOUCHED = [
  'interfold.config.yaml',
  'packages/crisp-contracts/deployed_contracts.json',
  'extensions/aztec/l1/deployed_contracts.json',
  'server/.env',
  'client/.env',
]

export type Deployment = {
  interfold: Address
  feeToken: Address
  ciphernodeRegistry: Address
  bondingRegistry: Address
  slashingManager: Address
  program: Address
  programBlock: number
  aztecContract: string
  /** Hashes of the verification keys of the three base circuits the contract pins. */
  baseVkHashes: { ct0: string; ct1: string; crisp: string }
  rollupVersion: number
  inbox: Address
  outbox: Address
  serverSigner: Address
  zkpassportDomain: string
}

const rpc = async <T>(method: string, params: unknown[] = []): Promise<T> => {
  const response = await fetch(L1_RPC_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  })
  const body = (await response.json()) as { result?: T; error?: { message: string } }
  if (body.error) throw new Error(`${method}: ${body.error.message}`)

  return body.result as T
}

// -------------------------------------------------------------------------------------------------------------
// Preflight and repo-file bookkeeping
// -------------------------------------------------------------------------------------------------------------

const preflight = async (): Promise<void> => {
  const chainId = Number(await rpc<string>('eth_chainId'))
  if (chainId !== L1_CHAIN_ID) throw new Error(`${L1_RPC_URL} is chain ${chainId}, expected ${L1_CHAIN_ID}`)
  const info = await fetch(AZTEC_NODE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'node_getNodeInfo', params: [] }),
  })
    .then((response) => response.json() as Promise<{ result?: { l1ContractAddresses: { inboxAddress: string } } }>)
    .catch((error) => {
      throw new Error(`The Aztec node at ${AZTEC_NODE_URL} is unreachable (start it with \`aztec start --local-network\`): ${error}`)
    })
  if (!info.result) throw new Error(`The Aztec node at ${AZTEC_NODE_URL} did not answer node_getNodeInfo`)
  if (!existsSync(paths.contractArtifact)) {
    throw new Error(`${paths.contractArtifact} is missing: run \`aztec compile\` in extensions/aztec/contracts`)
  }
  for (const [name, port] of Object.entries({ server: ports.server, program: ports.program, nodes: ports.nodesSupervisor, dashboard: ports.dashboard })) {
    if (await portOpen(port)) throw new Error(`Port ${port} (${name}) is in use: run \`pnpm test:e2e:aztec:down\` or stop the process holding it`)
  }
}

const snapshotRepoFiles = (state: State): void => {
  for (const file of TOUCHED) {
    if (file in state.snapshot) continue
    const path = join(REPO, file)
    state.snapshot[file] = existsSync(path) ? readFileSync(path, 'utf8') : null
  }
  saveState(state)
}

const restoreRepoFiles = (state: State): void => {
  for (const [file, contents] of Object.entries(state.snapshot)) {
    const path = join(REPO, file)
    if (contents === null) rmSync(path, { force: true })
    else writeFileSync(path, contents)
  }
  state.snapshot = {}
}

// -------------------------------------------------------------------------------------------------------------
// Tooling: interfold CLI, circuits, binaries
// -------------------------------------------------------------------------------------------------------------

const releaseAsset = (name: string): string =>
  run('node', [paths.releaseScript, 'asset', name], { cwd: REPO, logName: 'release' })
    .stdout.trim()
    .split('\n')
    .pop()!

/** The interfold CLI of the release `interfold-release.json` pins, or `INTERFOLD_BIN`. */
const ensureInterfoldCli = (): string => {
  if (process.env.INTERFOLD_BIN) return process.env.INTERFOLD_BIN
  const version = (JSON.parse(readFileSync(join(REPO, 'interfold-release.json'), 'utf8')) as { version: string }).version
  const bin = paths.interfoldBin
  if (existsSync(bin) && run(bin, ['--version'], { logName: 'interfold-version', allowFailure: true }).stdout.includes(version)) return bin

  const asset = `${platform()}-${arch()}` === 'darwin-arm64' ? 'interfold-macos-aarch64.tar.gz' : 'interfold-linux-x86_64.tar.gz'
  if (skipProofAggregation()) {
    throw new Error('CRISP_E2E_SKIP_PROOF_AGGREGATION=true needs INTERFOLD_BIN: a binary built with the test-only-skip-proof-aggregation feature')
  }
  log(`downloading interfold ${version} (${asset})`)
  const archive = releaseAsset(asset)
  mkdirSync(join(WORK, 'bin'), { recursive: true })
  run('tar', ['-xzf', archive, '-C', join(WORK, 'bin'), 'interfold'], { logName: 'release' })
  chmodSync(bin, 0o755)

  return bin
}

const interfoldEnv = (): Record<string, string> => {
  const flags: Record<string, string> = {}
  if (skipProofAggregation()) for (const node of ciphernodes) flags[`E3_NODES__${node.name.toUpperCase()}__SKIP_PROOF_AGGREGATION`] = 'true'

  return flags
}

const prepareBinaries = (): void => {
  log('building the CRISP server, the SDK and the keeper (cached builds are quick)')
  run('cargo', ['build', '--locked', '--bin', 'server'], { cwd: REPO, logName: 'build-server' })
  run('pnpm', ['-C', paths.sdkPkg, 'build'], { cwd: REPO, logName: 'build-sdk' })
  run('pnpm', ['-C', paths.keeperPkg, 'build'], { cwd: REPO, logName: 'build-keeper' })
  run('pnpm', ['compile'], { cwd: paths.l1Pkg, logName: 'compile-l1' })
}

// -------------------------------------------------------------------------------------------------------------
// Deploys
// -------------------------------------------------------------------------------------------------------------

type DeployedRecord = { address: Address; blockNumber: number }
const readRecords = (file: string, chain = 'localhost'): Record<string, DeployedRecord> =>
  (JSON.parse(readFileSync(file, 'utf8')) as Record<string, Record<string, DeployedRecord>>)[chain] ?? {}

const fund = async (): Promise<void> => {
  for (const who of Object.values(accounts)) await rpc('anvil_setBalance', [who.address, '0x21e19e0c9bab2400000'])
}

const deployInterfoldAndCrisp = (): Record<string, DeployedRecord> => {
  log('deploying the Interfold stack and CRISP (hardhat, deployer = harness account 0)')
  const base = { MNEMONIC, USE_MOCKS: 'true', DEPLOY_INTERFOLD: 'true', CRISP_UNPROVED_TEST: '1' }
  const zk = skipProofAggregation()
    ? {}
    : {
        ENABLE_ZK_VERIFICATION: 'true',
        INTERFOLD_CIRCUITS_DIR: join(REPO, 'circuits', 'interfold', 'release'),
      }
  run('node', [paths.releaseScript, 'circuits'], { cwd: REPO, logName: 'release' })
  run('pnpm', ['clean:deployments', '--network', 'localhost'], { cwd: paths.contractsPkg, env: base, logName: 'deploy-interfold' })
  run('pnpm', ['deploy:contracts', '--network', 'localhost'], { cwd: paths.contractsPkg, env: { ...base, ...zk }, logName: 'deploy-interfold' })

  return readRecords(paths.crispDeployments)
}

/** Deploys the L1 program; the second run, with the L2 address, only wires it up. */
const deployL1Program = (l2Address?: string): DeployedRecord => {
  run('pnpm', ['deploy:localhost'], {
    cwd: paths.l1Pkg,
    env: {
      MNEMONIC,
      AZTEC_NODE_URL,
      REDEPLOY: l2Address ? 'false' : 'true',
      ...(l2Address ? { CRISP_AZTEC_L2_ADDRESS: l2Address } : {}),
    },
    logName: 'deploy-l1-program',
  })

  return readRecords(paths.l1Deployments).CRISPAztecProgram
}

/** Seed the ZKPassport registry (a no-op after the first run: the clock was warped 24 hours then) and deploy `crisp_aztec`. */
const deployAztecSide = async (program: Address, interfold: Address): Promise<{ contract: string; baseVkHashes: Deployment['baseVkHashes']; rollupVersion: number }> => {
  log('seeding the ZKPassport registry (idempotent; warps the local network clock 24h the first time)')
  const registryContext = await connectRegistryContext(AZTEC_NODE_URL)
  try {
    const seeded = await seedLocalRegistry(registryContext)
    log(`registry ${LOCAL_NETWORK_REGISTRY_ADDRESS}: ${seeded.transactions.length} seeding tx(s)`)
  } finally {
    await registryContext.stop()
  }

  // The contract pins the verification keys of the three base circuits of the preset the round runs with.
  setCircuits(await loadCircuits())
  const keys = await getBaseVerificationKeys()
  destroyBBApi()
  const session = await connectAztec(AZTEC_NODE_URL)
  try {
    const contract = await deployCrispAztec(session, {
      l1Program: program,
      interfold,
      domainSeparator: domainSeparator(L1_CHAIN_ID, program),
      availabilitySignerPublicKey: accounts.server.account.publicKey,
      ct0VkHash: BigInt(keys.ct0.vkHash),
      ct1VkHash: BigInt(keys.ct1.vkHash),
      crispVkHash: BigInt(keys.crisp.vkHash),
      zkpassportDomainHash: domainHash(ZKPASSPORT_DOMAIN),
      zkpassportCircuitVersion: circuitsVersionField(CIRCUITS_VERSION),
      zkpassportValiditySeconds: ZKPASSPORT_VALIDITY_SECONDS,
      zkpassportRegistry: LOCAL_NETWORK_REGISTRY_ADDRESS,
    })
    const baseVkHashes = { ct0: keys.ct0.vkHash, ct1: keys.ct1.vkHash, crisp: keys.crisp.vkHash }
    return { contract: contract.address.toString(), baseVkHashes, rollupVersion: session.rollupVersion }
  } finally {
    await session.stop()
  }
}

// -------------------------------------------------------------------------------------------------------------
// Interfold config
// -------------------------------------------------------------------------------------------------------------

const interfoldConfig = (d: Deployment, records: Record<string, DeployedRecord>, programBlock: number): string => {
  const contract = (name: string, address: string, block: number) => `      ${name}:\n        address: "${address}"\n        deploy_block: ${block}\n`
  const nodes = ciphernodes
    .map((node, index) =>
      [
        `  ${node.name}:`,
        `    address: '${node.address}'`,
        `    quic_port: ${node.quic}`,
        `    ctrl_port: ${node.ctrl}`,
        '    autonetkey: true',
        '    autopassword: true',
        ...(index === 0 ? [`    dashboard_port: ${ports.dashboard}`] : ['    peers:', `      - /ip4/127.0.0.1/udp/${ciphernodes[0].quic}/quic-v1`]),
      ].join('\n'),
    )
    .join('\n')

  return `# Generated by extensions/aztec/e2e. Not committed.
chains:
  - name: localhost
    enabled: true
    rpc_url: ${L1_WS_URL}
    ingestion_confirmations: 0
    rpc_poll_interval_ms: 250
    data_availability:
      mode: mock_http
      rpc_url: http://127.0.0.1:${ports.server}/availability
    contracts:
${contract('e3_program', d.program, programBlock)}${contract('interfold', d.interfold, records.Interfold.blockNumber)}${contract('ciphernode_registry', d.ciphernodeRegistry, records.CiphernodeRegistryOwnable.blockNumber)}${contract('bonding_registry', d.bondingRegistry, records.BondingRegistry.blockNumber)}${contract('slashing_manager', d.slashingManager, records.SlashingManager.blockNumber)}${contract('fee_token', d.feeToken, records.MockUSDC.blockNumber)}program:
  dev: false
nodes:
${nodes}
`
}

// -------------------------------------------------------------------------------------------------------------
// up / down
// -------------------------------------------------------------------------------------------------------------

const serverEnv = (d: Deployment): Record<string, string> => ({
  PRIVATE_KEY: accounts.server.privateKey,
  INTERFOLD_SERVER_URL: SERVER_URL,
  CRISP_BIND_ADDR: `127.0.0.1:${ports.server}`,
  HTTP_RPC_URL: L1_RPC_URL,
  WS_RPC_URL: L1_WS_URL,
  PROGRAM_SERVER_URL: `http://127.0.0.1:${ports.program}`,
  CHAIN_ID: String(L1_CHAIN_ID),
  INTERFOLD_ADDRESS: d.interfold,
  FEE_TOKEN_ADDRESS: d.feeToken,
  E3_PROGRAM_ADDRESS: d.program,
  CIPHERNODE_REGISTRY_ADDRESS: d.ciphernodeRegistry,
  E3_PARAM_SET: String(E3_PARAM_SET),
  E3_COMMITTEE_SIZE: String(COMMITTEE_SIZE),
  E3_DURATION: '3600',
  VOTING_START_BUFFER_SECONDS: '20',
  DATA_AVAILABILITY_MODE: 'mock',
  E3_COMPUTE_PROVIDER_NAME: 'OpenVM',
  E3_COMPUTE_PROVIDER_PARALLEL: 'false',
  E3_COMPUTE_PROVIDER_BATCH_SIZE: '4',
  RELAY_MIN_BALANCE_ETH: '0',
  PROGRAM_KIND: 'aztec',
  AZTEC_NODE_URL,
  AZTEC_CONTRACT_ADDRESS: d.aztecContract,
  AZTEC_ATTESTATION_TTL_SECONDS: '3600',
  // The server verifies the staging pass of every ciphertext with `bb` 6.0.0.
  STAGING_PASS_VK_PATH: paths.stagingPassVk,
  BB_BINARY_PATH: env('BB_BINARY_PATH', join(homedir(), '.bb', 'bb')),
  RUST_LOG: env('RUST_LOG', 'info'),
})

export const up = async (): Promise<Deployment> => {
  const state = loadState()
  if (Object.keys(state.pids).some((name) => isRunning(state, name))) throw new Error('The stack is already running: `down` first')
  await preflight()
  snapshotRepoFiles(state)
  rmSync(WORK, { recursive: true, force: true })
  for (const dir of ['logs', 'server', 'bin']) workDir(dir)
  // `rmSync(WORK)` removed the state file as well; write it back.
  state.pids = {}
  saveState(state)

  const interfold = ensureInterfoldCli()
  prepareBinaries()
  await fund()

  const records = deployInterfoldAndCrisp()
  const l1Program = deployL1Program()
  const { contract, baseVkHashes, rollupVersion } = await deployAztecSide(getAddress(l1Program.address), records.Interfold.address)
  deployL1Program(contract)

  const info = await fetch(AZTEC_NODE_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'node_getNodeInfo', params: [] }),
  }).then((response) => response.json() as Promise<{ result: { l1ContractAddresses: { inboxAddress: string; outboxAddress: string } } }>)

  const deployment: Deployment = {
    interfold: records.Interfold.address,
    feeToken: records.MockUSDC.address,
    ciphernodeRegistry: records.CiphernodeRegistryOwnable.address,
    bondingRegistry: records.BondingRegistry.address,
    slashingManager: records.SlashingManager.address,
    program: getAddress(l1Program.address),
    programBlock: l1Program.blockNumber,
    aztecContract: contract,
    baseVkHashes,
    rollupVersion,
    inbox: getAddress(info.result.l1ContractAddresses.inboxAddress),
    outbox: getAddress(info.result.l1ContractAddresses.outboxAddress),
    serverSigner: accounts.server.address,
    zkpassportDomain: ZKPASSPORT_DOMAIN,
  }
  state.deployment = deployment
  saveState(state)
  log(`L1 program ${deployment.program}, Aztec contract ${deployment.aztecContract}`)

  writeFileSync(paths.interfoldConfig, interfoldConfig(deployment, records, deployment.programBlock))

  // ---- services ----
  const common = { cwd: WORK }
  startDaemon(state, 'randomness', 'node', [paths.randomnessScript], { cwd: REPO, env: { ANVIL_RPC_URL: L1_RPC_URL } })

  log('installing the Noir prover (bb + circuits) for the ciphernodes')
  const archive = releaseAsset(`circuits-${(JSON.parse(readFileSync(join(REPO, 'interfold-release.json'), 'utf8')) as { version: string }).version}.tar.gz`)
  run(interfold, ['noir', 'setup', '--circuits-archive', archive, '-c', paths.interfoldConfig, ...(process.env.INTERFOLD_BIN ? ['--allow-unpinned-archive'] : [])], {
    ...common,
    logName: 'noir-setup',
  })

  for (const node of ciphernodes) {
    run(interfold, ['wallet', 'set', '--name', node.name, '--private-key-stdin', '-c', paths.interfoldConfig], {
      ...common,
      input: `${node.key}\n`,
      logName: 'wallet-set',
    })
  }
  log('starting the ciphernodes')
  startDaemon(state, 'ciphernodes', interfold, ['nodes', 'up', '-v', '-c', paths.interfoldConfig], { ...common, env: interfoldEnv() })
  await waitFor(
    'the ciphernodes to start',
    async () => {
      return (await nodesStarted(interfold)) === ciphernodes.length
    },
    { timeoutMs: 120_000, intervalMs: 3000 },
  )
  await sleep(10_000)

  log('registering the ciphernodes with the bonding registry')
  const adminKey = accounts.deployer.privateKey
  for (const node of ciphernodes) {
    // Hardhat manages the default anvil mnemonic here (the ciphernodes' own keys), the admin key mints the tokens.
    run('pnpm', ['ciphernode:add', '--ciphernode-address', node.address, '--admin-private-key', adminKey, '--network', 'localhost'], {
      cwd: paths.contractsPkg,
      env: { MNEMONIC: undefined },
      logName: 'ciphernode-add',
    })
  }

  startDaemon(state, 'program', interfold, ['program', 'start', '--dev', 'true', '-c', paths.interfoldConfig], {
    cwd: REPO,
    env: { E3_PROGRAM__DEV: 'true', CRISP_UNPROVED_TEST: '1' },
  })
  await waitFor('the program server', () => portOpen(ports.program), { timeoutMs: 300_000, intervalMs: 2000 })

  startDaemon(state, 'server', paths.serverBinary, [], { cwd: workDir('server'), env: serverEnv(deployment) })
  await waitFor('the CRISP server', () => portOpen(ports.server), {
    timeoutMs: 120_000,
    intervalMs: 1000,
    onTick: () => {
      if (!isRunning(state, 'server')) throw new Error(`The CRISP server exited:\n${tail('server')}`)
    },
  })

  startDaemon(state, 'keeper', 'node', [paths.keeperMain], {
    cwd: REPO,
    env: {
      AZTEC_NODE_URL,
      L1_RPC_URL,
      KEEPER_L1_PRIVATE_KEY: accounts.keeper.privateKey,
      CRISP_AZTEC_PROGRAM: deployment.program,
      CRISP_AZTEC_CONTRACT: deployment.aztecContract,
      KEEPER_START_BLOCK: String(deployment.programBlock),
      KEEPER_POLL_INTERVAL_MS: env('CRISP_E2E_KEEPER_POLL_MS', '5000'),
    },
  })
  await sleep(2000)
  if (!isRunning(state, 'keeper')) throw new Error(`The keeper exited:\n${tail('keeper')}`)

  log('stack is up')

  return deployment
}

const nodesStarted = async (interfold: string): Promise<number> => {
  const { stdout } = run(interfold, ['nodes', 'ps', '-c', paths.interfoldConfig], { cwd: WORK, logName: 'nodes-ps', allowFailure: true })
  const lines = stdout.split('\n').filter((line) => /^cn\d+\s+Started/.test(line.trim()))

  return new Set(lines.map((line) => line.trim().split(/\s+/)[0])).size
}

export const down = async (): Promise<void> => {
  const state = loadState()
  for (const name of ['keeper', 'server', 'program', 'ciphernodes', 'randomness']) await stopDaemon(state, name)
  if (existsSync(paths.interfoldBin) && existsSync(paths.interfoldConfig)) {
    run(paths.interfoldBin, ['nodes', 'down', '-c', paths.interfoldConfig], { cwd: WORK, logName: 'nodes-down', allowFailure: true })
  }
  // The supervisor spawns `interfold start` children; stop any left in the harness' work dir.
  run('pkill', ['-f', `interfold.* -c ${paths.interfoldConfig}`], { logName: 'pkill', allowFailure: true })
  restoreRepoFiles(state)
  saveState(state)
  log(`stack is down; repo files restored (logs stay in ${join(WORK, 'logs')})`)
}
