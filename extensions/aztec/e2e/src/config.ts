// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Hex, toHex } from 'viem'
import { mnemonicToAccount } from 'viem/accounts'

const here = dirname(fileURLToPath(import.meta.url))

export const E2E_DIR = resolve(here, '..')
export const REPO = resolve(E2E_DIR, '..', '..', '..')
/** Everything the harness writes: logs, state, the interfold config and the ciphernodes' data. Gitignored. */
export const WORK = process.env.CRISP_E2E_WORK ? resolve(process.env.CRISP_E2E_WORK) : join(E2E_DIR, '.work')
export const LOGS = join(WORK, 'logs')
export const STATE_FILE = join(WORK, 'state.json')

export const paths = {
  contractsPkg: join(REPO, 'packages', 'crisp-contracts'),
  l1Pkg: join(REPO, 'extensions', 'aztec', 'l1'),
  keeperPkg: join(REPO, 'extensions', 'aztec', 'keeper'),
  sdkPkg: join(REPO, 'extensions', 'aztec', 'sdk'),
  crispDeployments: join(REPO, 'packages', 'crisp-contracts', 'deployed_contracts.json'),
  l1Deployments: join(REPO, 'extensions', 'aztec', 'l1', 'deployed_contracts.json'),
  interfoldArtifact: join(REPO, 'packages', 'crisp-contracts', 'node_modules', '@interfold', 'contracts', 'artifacts', 'contracts', 'Interfold.sol', 'Interfold.json'),
  releaseScript: join(REPO, 'scripts', 'interfold-release.mjs'),
  randomnessScript: join(REPO, 'scripts', 'anvil-randomness.mjs'),
  serverBinary: join(REPO, 'target', 'debug', 'server'),
  /** The staging pass circuit's verification key the server checks passes with (`extensions/core/circuits/staging_pass`). */
  stagingPassVk: join(REPO, 'extensions', 'core', 'circuits', 'staging_pass', 'compiled', 'staging_pass.vk'),
  keeperMain: join(REPO, 'extensions', 'aztec', 'keeper', 'dist', 'main.js'),
  contractArtifact: join(REPO, 'extensions', 'aztec', 'contracts', 'target', 'crisp_aztec-CrispAztec.json'),
  interfoldBin: join(WORK, 'bin', 'interfold'),
  interfoldConfig: join(WORK, 'interfold.config.yaml'),
}

export const AZTEC_NODE_URL = process.env.AZTEC_NODE_URL ?? 'http://localhost:8080'
export const L1_RPC_URL = process.env.L1_RPC_URL ?? 'http://localhost:8545'
export const L1_WS_URL = L1_RPC_URL.replace(/^http/, 'ws')
export const L1_CHAIN_ID = 31337

export const ports = {
  server: 4000,
  program: 13151,
  nodesSupervisor: 13415,
  /** The default dashboard port (8080) belongs to the Aztec node on a local network. */
  dashboard: 8090,
}
export const SERVER_URL = `http://127.0.0.1:${ports.server}`

/**
 * The accounts the harness uses on the Aztec network's anvil. The local network's sequencer publishes from the
 * default mnemonic's index 0, so none of these share it: a second sender there races its nonce.
 */
export const MNEMONIC = process.env.CRISP_E2E_MNEMONIC ?? 'legal winner thank year wave sausage worth useful legal winner thank yellow'
const account = (addressIndex: number) => {
  const a = mnemonicToAccount(MNEMONIC, { addressIndex })
  return { address: a.address, privateKey: toHex(a.getHdKey().privateKey!) as Hex, account: a }
}
export const accounts = {
  /** Deploys the stacks, owns Interfold and the programs, mints the fee token. */
  deployer: account(0),
  /** The CRISP server's key: signs availability attestations and sends the server's L1 transactions. */
  server: account(1),
  /** The poll creator: the one L1 transaction of a round (`Interfold.request`). */
  creator: account(2),
  /** The keeper's L1 gas payer. */
  keeper: account(3),
}

/**
 * The ciphernodes of `interfold.config.yaml` are the default anvil mnemonic's accounts 1-5 (funded on every anvil, and
 * not the sequencer's). Their keys are the well-known anvil keys, not secrets.
 */
export const ciphernodes = [
  { name: 'cn1', address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', key: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d', quic: 9201, ctrl: 50501 },
  { name: 'cn2', address: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC', key: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a', quic: 9202, ctrl: 50502 },
  { name: 'cn3', address: '0x90F79bf6EB2c4f870365E785982E1f101E93b906', key: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6', quic: 9203, ctrl: 50503 },
  { name: 'cn4', address: '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65', key: '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a', quic: 9204, ctrl: 50504 },
  { name: 'cn5', address: '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc', key: '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba', quic: 9205, ctrl: 50505 },
] as const

/** The BFV preset of the round: `insecure-64` is the dev preset (`E3_PARAM_SET=4`, `BfvProtocol.INSECURE_PARAM_SET`; secure-8192 is 3). */
export const BFV_PRESET = 'insecure-64'
export const E3_PARAM_SET = 4
/**
 * `BfvProtocol.SS_INSECURE_64_MINIMUM_CONFIG_ID` (`@interfold/contracts` 0.20.0, `contracts/lib/BfvProtocol.sol`): the
 * committee-bound id `request` expects for an insecure-64 round with a Minimum committee.
 */
export const INSECURE_CONFIG_ID = '0xd76c4f521394e6cbe1df28036cc5dd5590c6630a403525b5c2b052f9b91507f4'
/** `E3_COMMITTEE_SIZE` 0 = Minimum (3 members). */
export const COMMITTEE_SIZE = 0

/** The ZKPassport domain the harness' rounds verify: its hash is a constructor argument of the contract. */
export const ZKPASSPORT_DOMAIN = 'crisp-aztec.local'
export const ZKPASSPORT_VALIDITY_SECONDS = 86_400n

export const env = (name: string, fallback: string): string => process.env[name]?.trim() || fallback
export const envInt = (name: string, fallback: number): number => {
  const value = process.env[name]?.trim()
  if (!value) return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number, got ${value}`)

  return parsed
}
