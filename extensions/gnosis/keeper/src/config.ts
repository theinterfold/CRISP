// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { getAddress, isHex, type Address, type Hex } from 'viem'

export type KeeperConfig = {
  sepoliaRpcUrl: string
  /** Pays the gas of the Sepolia transactions (`publishCommitteeKey`, `executeSignatures`, `relayResult`). */
  sepoliaPrivateKey: Hex
  chiadoRpcUrl: string
  /** Pays the gas of the Chiado transactions (`closeRound`, and the module and the Delay when they run). */
  chiadoPrivateKey: Hex
  /** `CRISPGnosisProgram` on Sepolia. */
  program: Address
  /** `CrispGnosisVoting` on Chiado. */
  voting: Address
  /** The AMB Helper on Chiado: packs the validators' signatures of the ROOT message. */
  ambHelper: Address
  /** `CrispGovernanceModule`: set to also execute passed proposals and run the Delay's queue. */
  module?: Address
  /** Where a proposal's metadata JSON is served, `{cid}` standing for its CID: the keeper reads `packedTransactions` from it. */
  metadataUrl?: string
  /** First block to look for proposals in, on Sepolia, and for Delay entries on Chiado. */
  startBlockSepolia: bigint
  startBlockChiado: bigint
  pollIntervalMs: number
}

const required = (env: Record<string, string | undefined>, name: string): string => {
  const value = env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)

  return value
}

const privateKey = (env: Record<string, string | undefined>, name: string): Hex => {
  const value = required(env, name)
  if (!isHex(value, { strict: true }) || value.length !== 66) throw new Error(`${name} must be a 32-byte hex string`)

  return value
}

/** Read the keeper's configuration from the environment; fails on the first missing or malformed value. */
export const loadConfig = (env: Record<string, string | undefined>): KeeperConfig => {
  const pollIntervalMs = Number(env.KEEPER_POLL_INTERVAL_MS ?? 10_000)
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs <= 0) throw new Error('KEEPER_POLL_INTERVAL_MS must be a positive integer')

  const module = env.CRISP_GOVERNANCE_MODULE?.trim()
  const metadataUrl = env.KEEPER_METADATA_URL?.trim()
  if (module && !metadataUrl) throw new Error('KEEPER_METADATA_URL is required with CRISP_GOVERNANCE_MODULE: the keeper reads each batch from the proposal metadata')
  if (metadataUrl && !metadataUrl.includes('{cid}')) throw new Error('KEEPER_METADATA_URL must contain {cid}')

  return {
    sepoliaRpcUrl: required(env, 'KEEPER_SEPOLIA_RPC_URL'),
    sepoliaPrivateKey: privateKey(env, 'KEEPER_SEPOLIA_PRIVATE_KEY'),
    chiadoRpcUrl: required(env, 'KEEPER_CHIADO_RPC_URL'),
    chiadoPrivateKey: privateKey(env, 'KEEPER_CHIADO_PRIVATE_KEY'),
    program: getAddress(required(env, 'CRISP_GNOSIS_PROGRAM')),
    voting: getAddress(required(env, 'CRISP_GNOSIS_VOTING')),
    ambHelper: getAddress(required(env, 'KEEPER_AMB_HELPER')),
    module: module ? getAddress(module) : undefined,
    metadataUrl,
    startBlockSepolia: BigInt(env.KEEPER_START_BLOCK_SEPOLIA ?? 0),
    startBlockChiado: BigInt(env.KEEPER_START_BLOCK_CHIADO ?? 0),
    pollIntervalMs,
  }
}
