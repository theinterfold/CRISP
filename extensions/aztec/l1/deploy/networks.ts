// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const crispDeployments = path.resolve(here, '..', '..', '..', '..', 'packages', 'crisp-contracts', 'deployed_contracts.json')
const ownDeployments = path.resolve(here, '..', 'deployed_contracts.json')

/** Aztec's L1 message bridge on a network. */
export interface AztecBridge {
  inbox: string
  outbox: string
  rollupVersion: bigint
}

/** Aztec testnet on Ethereum Sepolia. The deploy script refuses these if the contracts report another version. */
export const SEPOLIA_AZTEC: AztecBridge = {
  inbox: '0x7cdC32Dd7d008870A95f1837Ffd7229ef676EF8A',
  outbox: '0xA5A0f7a7BDAf280964a1922A68C83462E5F6E15b',
  rollupVersion: 679261766n,
}

/** ZKPassport's root verifier, deployed at the same address on every network ZKPassport supports. */
export const ZKPASSPORT_ROOT_VERIFIER = '0x1D000001000EFD9a6371f4d90bB8920D5431c0D8'

/**
 * The Inbox, Outbox and rollup version of the local network (`aztec start --local-network`), read from its node: a
 * local network picks a new rollup version and new L1 addresses on every start.
 */
export async function localAztecBridge(nodeUrl: string): Promise<AztecBridge> {
  const response = await fetch(nodeUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'node_getNodeInfo', params: [] }),
  })
  const { result, error } = (await response.json()) as { result?: any; error?: { message: string } }
  if (!result) throw new Error(`Aztec node ${nodeUrl} did not answer node_getNodeInfo: ${error?.message ?? response.status}`)
  return {
    inbox: result.l1ContractAddresses.inboxAddress,
    outbox: result.l1ContractAddresses.outboxAddress,
    rollupVersion: BigInt(result.rollupVersion),
  }
}

export interface Record {
  address: string
  blockNumber: number
  constructorArgs?: object
}

function readJson(file: string): any {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {}
}

/** An entry of `packages/crisp-contracts/deployed_contracts.json`, which the CRISP deploy (`pnpm deploy:contracts`) writes. */
export function readCrispDeployment(chain: string, name: string): Record | undefined {
  return readJson(crispDeployments)[chain]?.[name]
}

export function readDeployment(chain: string, name: string): Record | undefined {
  return readJson(ownDeployments)[chain]?.[name]
}

export function storeDeployment(chain: string, name: string, record: Record): void {
  const all = readJson(ownDeployments)
  all[chain] = { ...all[chain], [name]: record }
  writeFileSync(ownDeployments, `${JSON.stringify(all, null, 2)}\n`)
}
