// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { parseAbi, type Address, type Hex, type PublicClient, type WalletClient } from 'viem'

import { findLog } from './logs'

/** The part of the Zodiac Delay modifier the keeper and the app use. */
export const delayAbi = parseAbi([
  'function txCooldown() view returns (uint256)',
  'function txExpiration() view returns (uint256)',
  'function txNonce() view returns (uint256)',
  'function queueNonce() view returns (uint256)',
  'function txCreatedAt(uint256 nonce) view returns (uint256)',
  'function executeNextTx(address to, uint256 value, bytes data, uint8 operation)',
  'function skipExpired()',
  'event TransactionAdded(uint256 indexed queueNonce, bytes32 indexed txHash, address to, uint256 value, bytes data, uint8 operation)',
])

export type QueuedTx = { to: Address; value: bigint; data: Hex; operation: number }

/** What a Delay's next queued transaction is waiting for. */
export type DelayState = {
  /** The next transaction to run, and the number queued so far: the queue is empty when they are equal. */
  txNonce: bigint
  queueNonce: bigint
  /** Unix seconds from which the next transaction may run, and until which (`undefined`: never expires). */
  readyAt?: bigint
  expiresAt?: bigint
}

export const getDelayState = async (client: PublicClient, delay: Address): Promise<DelayState> => {
  const [txNonce, queueNonce, cooldown, expiration] = await Promise.all([
    client.readContract({ address: delay, abi: delayAbi, functionName: 'txNonce' }),
    client.readContract({ address: delay, abi: delayAbi, functionName: 'queueNonce' }),
    client.readContract({ address: delay, abi: delayAbi, functionName: 'txCooldown' }),
    client.readContract({ address: delay, abi: delayAbi, functionName: 'txExpiration' }),
  ])
  if (txNonce >= queueNonce) return { txNonce, queueNonce }
  const createdAt = await client.readContract({ address: delay, abi: delayAbi, functionName: 'txCreatedAt', args: [txNonce] })
  const readyAt = createdAt + cooldown

  return { txNonce, queueNonce, readyAt, expiresAt: expiration === 0n ? undefined : readyAt + expiration }
}

/** The transaction the Delay queued as entry `nonce`, from its `TransactionAdded` log. */
export const getQueuedTx = async (client: PublicClient, delay: Address, nonce: bigint, fromBlock = 0n): Promise<QueuedTx> => {
  const added = await findLog(
    (from, to) => client.getContractEvents({ address: delay, abi: delayAbi, eventName: 'TransactionAdded', args: { queueNonce: nonce }, fromBlock: from, toBlock: to }),
    fromBlock,
    await client.getBlockNumber(),
  )
  if (!added) throw new Error(`The Delay ${delay} has no TransactionAdded log for queue entry ${nonce}`)
  const { to, value, data, operation } = added.args

  return { to: to!, value: value!, data: data!, operation: operation! }
}

/** Run the Delay's next queued transaction. Permissionless once its cooldown has passed. */
export const executeNextTx = async (wallet: WalletClient, client: PublicClient, delay: Address, tx: QueuedTx): Promise<Hex> => {
  const { request } = await client.simulateContract({
    address: delay,
    abi: delayAbi,
    functionName: 'executeNextTx',
    args: [tx.to, tx.value, tx.data, tx.operation],
    account: wallet.account,
  })

  return wallet.writeContract(request)
}

/** Move the Delay's queue past its expired head entries. Permissionless. */
export const skipExpired = async (wallet: WalletClient, client: PublicClient, delay: Address): Promise<Hex> => {
  const { request } = await client.simulateContract({ address: delay, abi: delayAbi, functionName: 'skipExpired', account: wallet.account })

  return wallet.writeContract(request)
}
