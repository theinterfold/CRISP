// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { getAddress, isHex, type Address, type Hex } from 'viem'

export type KeeperConfig = {
  aztecNodeUrl: string
  l1RpcUrl: string
  /** Pays the gas of the L1 transactions; holds no other authority. */
  l1PrivateKey: Hex
  /** `CRISPAztecProgram` on L1. */
  program: Address
  /** `crisp_aztec` on Aztec. */
  contract: string
  /** First L1 block to look for rounds in. */
  startBlock: bigint
  pollIntervalMs: number
}

const required = (env: Record<string, string | undefined>, name: string): string => {
  const value = env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)

  return value
}

/** Read the keeper's configuration from the environment; fails on the first missing or malformed value. */
export const loadConfig = (env: Record<string, string | undefined>): KeeperConfig => {
  const l1PrivateKey = required(env, 'KEEPER_L1_PRIVATE_KEY')
  if (!isHex(l1PrivateKey, { strict: true }) || l1PrivateKey.length !== 66)
    throw new Error('KEEPER_L1_PRIVATE_KEY must be a 32-byte hex string')

  const pollIntervalMs = Number(env.KEEPER_POLL_INTERVAL_MS ?? 10_000)
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs <= 0) throw new Error('KEEPER_POLL_INTERVAL_MS must be a positive integer')

  return {
    aztecNodeUrl: required(env, 'AZTEC_NODE_URL'),
    l1RpcUrl: required(env, 'L1_RPC_URL'),
    l1PrivateKey,
    program: getAddress(required(env, 'CRISP_AZTEC_PROGRAM')),
    contract: required(env, 'CRISP_AZTEC_CONTRACT'),
    startBlock: BigInt(env.KEEPER_START_BLOCK ?? 0),
    pollIntervalMs,
  }
}
