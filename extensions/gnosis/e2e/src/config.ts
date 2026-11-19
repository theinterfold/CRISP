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
  gnosisContracts: join(REPO, 'extensions', 'gnosis', 'contracts'),
  keeperPkg: join(REPO, 'extensions', 'gnosis', 'keeper'),
  sdkPkg: join(REPO, 'extensions', 'gnosis', 'sdk'),
  crispDeployments: join(REPO, 'packages', 'crisp-contracts', 'deployed_contracts.json'),
  gnosisDeployments: join(REPO, 'extensions', 'gnosis', 'contracts', 'deployments', 'localhost.json'),
  releaseScript: join(REPO, 'scripts', 'interfold-release.mjs'),
  randomnessScript: join(REPO, 'scripts', 'anvil-randomness.mjs'),
  serverBinary: join(REPO, 'target', 'debug', 'server'),
  keeperMain: join(REPO, 'extensions', 'gnosis', 'keeper', 'dist', 'main.js'),
  relayerMain: join(E2E_DIR, 'src', 'relayer.ts'),
  metadataMain: join(E2E_DIR, 'src', 'metadata.ts'),
  metadataDir: join(WORK, 'metadata'),
  interfoldBin: join(WORK, 'bin', 'interfold'),
  interfoldConfig: join(WORK, 'interfold.config.yaml'),
}

/**
 * One anvil plays both chains: Sepolia (Interfold, the program) and Chiado (voting, token, Safe), as two AMB mocks
 * connect them. The harness starts it, so the chain id is the one every Interfold dev tool assumes.
 */
export const RPC_URL = process.env.CRISP_E2E_RPC_URL ?? 'http://127.0.0.1:8545'
export const WS_URL = RPC_URL.replace(/^http/, 'ws')
export const RPC_PORT = Number(new URL(RPC_URL).port || 8545)
export const CHAIN_ID = 31337

export const ports = {
  server: 4000,
  program: 13151,
  nodesSupervisor: 13415,
  dashboard: 8090,
  metadata: 4010,
}
export const SERVER_URL = `http://127.0.0.1:${ports.server}`
export const METADATA_URL = `http://127.0.0.1:${ports.metadata}`

/** The harness' accounts, funded through `anvil_setBalance`. None is one of the ciphernodes' (anvil mnemonic 1-5). */
export const MNEMONIC = process.env.CRISP_E2E_MNEMONIC ?? 'legal winner thank year wave sausage worth useful legal winner thank yellow'
const account = (addressIndex: number) => {
  const a = mnemonicToAccount(MNEMONIC, { addressIndex })
  return { address: a.address, privateKey: toHex(a.getHdKey().privateKey!) as Hex, account: a }
}
export const accounts = {
  /** Deploys everything, owns Interfold, the program and the Safe, mints the fee token. */
  deployer: account(0),
  /** The CRISP server's key: relay, availability attestation and compute sender. */
  server: account(1),
  /** The proposer: pays the fee, sends `Interfold.request`. */
  proposer: account(2),
  /** The keeper's gas payer on both chains. */
  keeper: account(3),
  /** The token faucet the server mints with. */
  faucet: account(4),
  /** The mock AMB relayer's gas payer. */
  relayer: account(5),
  /** Receives the tokens the proposal moves out of the Safe. */
  recipient: account(6),
}

/**
 * The ciphernodes of `interfold.config.yaml` are the default anvil mnemonic's accounts 1-5 (funded on every anvil).
 * Their keys are the well-known anvil keys, not secrets.
 */
export const ciphernodes = [
  { name: 'cn1', address: '0x70997970C51812dc3A010C7d01b50e0d17dc79C8', key: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d', quic: 9201, ctrl: 50501 },
  { name: 'cn2', address: '0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC', key: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a', quic: 9202, ctrl: 50502 },
  { name: 'cn3', address: '0x90F79bf6EB2c4f870365E785982E1f101E93b906', key: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6', quic: 9203, ctrl: 50503 },
  { name: 'cn4', address: '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65', key: '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a', quic: 9204, ctrl: 50504 },
  { name: 'cn5', address: '0x9965507D1a55bcC2695C58ba16FB37d819B0A4dc', key: '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba', quic: 9205, ctrl: 50505 },
] as const

/** The BFV preset of the round: `insecure-64` is the dev preset (`E3_PARAM_SET=0`). */
export const BFV_PRESET = 'insecure-64'
export const E3_PARAM_SET = 0
/** `ActiveCryptoConfigId.INSECURE_CONFIG_ID`: what `request` expects for param set 0. */
export const INSECURE_CONFIG_ID = '0x92c8b373eb72cc3600a5a818cf8599db16e618ee3ece2dadd14f8608c1a43ac9'
/** `E3_COMMITTEE_SIZE` 0 = Minimum (3 members). */
export const COMMITTEE_SIZE = 0

export const env = (name: string, fallback: string): string => process.env[name]?.trim() || fallback
export const envInt = (name: string, fallback: number): number => {
  const value = process.env[name]?.trim()
  if (!value) return fallback
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a number, got ${value}`)

  return parsed
}
