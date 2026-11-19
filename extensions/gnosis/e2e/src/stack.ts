// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { arch, platform } from 'node:os'
import { join } from 'node:path'

import { getAddress, type Address } from 'viem'

import {
  CHAIN_ID,
  COMMITTEE_SIZE,
  E3_PARAM_SET,
  METADATA_URL,
  MNEMONIC,
  REPO,
  RPC_PORT,
  RPC_URL,
  SERVER_URL,
  WORK,
  WS_URL,
  accounts,
  ciphernodes,
  env,
  paths,
  ports,
} from './config'
import { type State, isRunning, loadState, log, portOpen, run, saveState, sleep, startDaemon, stopDaemon, tail, waitFor, workDir } from './proc'

/** Whether the ciphernodes skip proof aggregation (needs an interfold binary built with `test-only-skip-proof-aggregation`). */
export const skipProofAggregation = () => env('CRISP_E2E_SKIP_PROOF_AGGREGATION', 'false') === 'true'

/** Repo files the deploy scripts rewrite. They are restored (or removed) by `down`. */
const TOUCHED = [
  'interfold.config.yaml',
  'packages/crisp-contracts/deployed_contracts.json',
  'extensions/gnosis/contracts/deployments/localhost.json',
  'server/.env',
  'client/.env',
]

/** The addresses of a deployed stack: the Interfold side and the (same-chain) voting side. */
export type Deployment = {
  interfold: Address
  feeToken: Address
  ciphernodeRegistry: Address
  bondingRegistry: Address
  slashingManager: Address
  program: Address
  programBlock: number
  foreignAmb: Address
  homeAmb: Address
  ambHelper: Address
  voting: Address
  token: Address
  safe: Address
  delay: Address
  module: Address
  multiSendCallOnly: Address
  /** The block the voting side was deployed in. */
  deployBlock: number
}

type DeployedRecord = { address: Address; blockNumber: number }
const readRecords = (file: string, chain = 'localhost'): Record<string, DeployedRecord> =>
  (JSON.parse(readFileSync(file, 'utf8')) as Record<string, Record<string, DeployedRecord>>)[chain] ?? {}

export const rpc = async <T>(method: string, params: unknown[] = []): Promise<T> => {
  const send = () =>
    fetch(RPC_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
    })
  // A connection anvil closed while the prover blocked the event loop is reset when reused: send once more.
  const response = await send().catch(send)
  const body = (await response.json()) as { result?: T; error?: { message: string } }
  if (body.error) throw new Error(`${method}: ${body.error.message}`)

  return body.result as T
}

// -------------------------------------------------------------------------------------------------------------
// Preflight and repo-file bookkeeping
// -------------------------------------------------------------------------------------------------------------

const preflight = async (): Promise<void> => {
  const checks = { anvil: RPC_PORT, server: ports.server, program: ports.program, nodes: ports.nodesSupervisor, dashboard: ports.dashboard, metadata: ports.metadata }
  for (const [name, port] of Object.entries(checks)) {
    if (await portOpen(port)) throw new Error(`Port ${port} (${name}) is in use: run \`pnpm test:e2e:gnosis:down\` or stop the process holding it`)
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
// Tooling: interfold CLI, binaries
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
  log('building the CRISP server, the SDK, the keeper and the contracts (cached builds are quick)')
  run('cargo', ['build', '--locked', '--bin', 'server'], { cwd: REPO, logName: 'build-server' })
  run('pnpm', ['-C', paths.sdkPkg, 'build'], { cwd: REPO, logName: 'build-sdk' })
  run('pnpm', ['-C', paths.keeperPkg, 'build'], { cwd: REPO, logName: 'build-keeper' })
  run('forge', ['build'], { cwd: paths.gnosisContracts, logName: 'build-contracts' })
}

// -------------------------------------------------------------------------------------------------------------
// Deploys
// -------------------------------------------------------------------------------------------------------------

const fund = async (): Promise<void> => {
  for (const who of Object.values(accounts)) await rpc('anvil_setBalance', [who.address, '0x21e19e0c9bab2400000'])
}

const deployInterfoldAndCrisp = (): Record<string, DeployedRecord> => {
  log('deploying the Interfold stack (hardhat, deployer = harness account 0)')
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

type GnosisRecord = Record<string, string | number>

/** Deploy the CRISP Gnosis contracts on the same anvil: the program (Sepolia side), the AMB mocks and the voting side. */
const deployGnosis = (interfold: Address): GnosisRecord => {
  log('deploying the CRISP Gnosis contracts (forge script DeployLocal)')
  run(
    'forge',
    ['script', 'script/DeployLocal.s.sol', '--rpc-url', RPC_URL, '--broadcast', '--private-key', accounts.deployer.privateKey],
    {
      cwd: paths.gnosisContracts,
      env: {
        INTERFOLD: interfold,
        INPUT_SIGNER: accounts.server.address,
        FAUCET: accounts.faucet.address,
        PROPOSER: accounts.proposer.address,
      },
      logName: 'deploy-gnosis',
    },
  )

  return JSON.parse(readFileSync(paths.gnosisDeployments, 'utf8')) as GnosisRecord
}

// -------------------------------------------------------------------------------------------------------------
// Interfold config
// -------------------------------------------------------------------------------------------------------------

const interfoldConfig = (d: Deployment, records: Record<string, DeployedRecord>): string => {
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

  return `# Generated by extensions/gnosis/e2e. Not committed.
chains:
  - name: localhost
    enabled: true
    rpc_url: ${WS_URL}
    ingestion_confirmations: 0
    rpc_poll_interval_ms: 250
    data_availability:
      mode: mock_http
      rpc_url: http://127.0.0.1:${ports.server}/availability
    contracts:
${contract('e3_program', d.program, d.programBlock)}${contract('interfold', d.interfold, records.Interfold.blockNumber)}${contract('ciphernode_registry', d.ciphernodeRegistry, records.CiphernodeRegistryOwnable.blockNumber)}${contract('bonding_registry', d.bondingRegistry, records.BondingRegistry.blockNumber)}${contract('slashing_manager', d.slashingManager, records.SlashingManager.blockNumber)}${contract('fee_token', d.feeToken, records.MockUSDC.blockNumber)}program:
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
  HTTP_RPC_URL: RPC_URL,
  WS_RPC_URL: WS_URL,
  PROGRAM_SERVER_URL: `http://127.0.0.1:${ports.program}`,
  CHAIN_ID: String(CHAIN_ID),
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
  PROGRAM_KIND: 'gnosis',
  GNOSIS_RPC_URL: RPC_URL,
  GNOSIS_PUBLIC_RPC_URL: RPC_URL,
  GNOSIS_CHAIN_ID: String(CHAIN_ID),
  GNOSIS_VOTING_ADDRESS: d.voting,
  GNOSIS_TOKEN_ADDRESS: d.token,
  GNOSIS_START_BLOCK: String(d.deployBlock),
  GNOSIS_ATTESTATION_TTL_SECONDS: '3600',
  FAUCET_ENABLED: 'true',
  FAUCET_PRIVATE_KEY: accounts.faucet.privateKey,
  RUST_LOG: env('RUST_LOG', 'info'),
})

export const up = async (): Promise<Deployment> => {
  const state = loadState()
  if (Object.keys(state.pids).some((name) => isRunning(state, name))) throw new Error('The stack is already running: `down` first')
  await preflight()
  snapshotRepoFiles(state)
  rmSync(WORK, { recursive: true, force: true })
  for (const dir of ['logs', 'server', 'bin', 'metadata']) workDir(dir)
  // `rmSync(WORK)` removed the state file as well; write it back.
  state.pids = {}
  saveState(state)

  const interfold = ensureInterfoldCli()
  prepareBinaries()

  startDaemon(state, 'anvil', 'anvil', ['--chain-id', String(CHAIN_ID), '--block-time', '1', '--port', String(RPC_PORT), '--code-size-limit', '1000000', '--gas-limit', '100000000', '--silent'])
  await waitFor('anvil', () => portOpen(RPC_PORT), { timeoutMs: 30_000, intervalMs: 500 })
  await fund()

  const records = deployInterfoldAndCrisp()
  const gnosis = deployGnosis(records.Interfold.address)

  const addr = (key: string): Address => getAddress(gnosis[key] as string)
  const deployment: Deployment = {
    interfold: records.Interfold.address,
    feeToken: records.MockUSDC.address,
    ciphernodeRegistry: records.CiphernodeRegistryOwnable.address,
    bondingRegistry: records.BondingRegistry.address,
    slashingManager: records.SlashingManager.address,
    program: addr('program'),
    programBlock: Number(gnosis.deployBlock),
    foreignAmb: addr('foreignAmb'),
    homeAmb: addr('homeAmb'),
    ambHelper: addr('ambHelper'),
    voting: addr('voting'),
    token: addr('token'),
    safe: addr('safe'),
    delay: addr('delay'),
    module: addr('module'),
    multiSendCallOnly: addr('multiSendCallOnly'),
    deployBlock: Number(gnosis.deployBlock),
  }
  state.deployment = deployment
  saveState(state)
  log(`program ${deployment.program}, voting ${deployment.voting}, module ${deployment.module}`)

  writeFileSync(paths.interfoldConfig, interfoldConfig(deployment, records))

  // ---- services ----
  const common = { cwd: WORK }
  startDaemon(state, 'randomness', 'node', [paths.randomnessScript], { cwd: REPO, env: { ANVIL_RPC_URL: RPC_URL } })

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
  await waitFor('the ciphernodes to start', async () => (await nodesStarted(interfold)) === ciphernodes.length, { timeoutMs: 120_000, intervalMs: 3000 })
  await sleep(10_000)

  log('registering the ciphernodes with the bonding registry')
  for (const node of ciphernodes) {
    // Hardhat manages the default anvil mnemonic here (the ciphernodes' own keys), the admin key mints the tokens.
    run('pnpm', ['ciphernode:add', '--ciphernode-address', node.address, '--admin-private-key', accounts.deployer.privateKey, '--network', 'localhost'], {
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

  startDaemon(state, 'metadata', 'node', ['--import', 'tsx', paths.metadataMain], {
    cwd: join(REPO, 'extensions', 'gnosis', 'e2e'),
    env: { METADATA_DIR: paths.metadataDir, METADATA_PORT: String(ports.metadata) },
  })
  startDaemon(state, 'relayer', 'node', ['--import', 'tsx', paths.relayerMain], {
    cwd: join(REPO, 'extensions', 'gnosis', 'e2e'),
    env: {
      RELAYER_RPC_URL: RPC_URL,
      RELAYER_PRIVATE_KEY: accounts.relayer.privateKey,
      RELAYER_FOREIGN_AMB: deployment.foreignAmb,
      RELAYER_HOME_AMB: deployment.homeAmb,
      RELAYER_START_BLOCK: String(deployment.deployBlock),
    },
  })
  startDaemon(state, 'keeper', 'node', [paths.keeperMain], {
    cwd: REPO,
    env: {
      KEEPER_SEPOLIA_RPC_URL: RPC_URL,
      KEEPER_SEPOLIA_PRIVATE_KEY: accounts.keeper.privateKey,
      KEEPER_CHIADO_RPC_URL: RPC_URL,
      KEEPER_CHIADO_PRIVATE_KEY: accounts.keeper.privateKey,
      CRISP_GNOSIS_PROGRAM: deployment.program,
      CRISP_GNOSIS_VOTING: deployment.voting,
      CRISP_GOVERNANCE_MODULE: deployment.module,
      KEEPER_AMB_HELPER: deployment.ambHelper,
      KEEPER_METADATA_URL: `${METADATA_URL}/{cid}`,
      KEEPER_START_BLOCK_SEPOLIA: String(deployment.programBlock),
      KEEPER_START_BLOCK_CHIADO: String(deployment.deployBlock),
      KEEPER_POLL_INTERVAL_MS: env('CRISP_E2E_KEEPER_POLL_MS', '3000'),
    },
  })
  await sleep(2000)
  for (const name of ['metadata', 'relayer', 'keeper']) {
    if (!isRunning(state, name)) throw new Error(`The ${name} exited:\n${tail(name)}`)
  }

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
  for (const name of ['keeper', 'relayer', 'metadata', 'server', 'program', 'ciphernodes', 'randomness', 'anvil']) await stopDaemon(state, name)
  if (existsSync(paths.interfoldBin) && existsSync(paths.interfoldConfig)) {
    run(paths.interfoldBin, ['nodes', 'down', '-c', paths.interfoldConfig], { cwd: WORK, logName: 'nodes-down', allowFailure: true })
  }
  // The supervisor spawns `interfold start` children; stop any left in the harness' work dir.
  run('pkill', ['-f', `interfold.* -c ${paths.interfoldConfig}`], { logName: 'pkill', allowFailure: true })
  restoreRepoFiles(state)
  saveState(state)
  log(`stack is down; repo files restored (logs stay in ${join(WORK, 'logs')})`)
}
