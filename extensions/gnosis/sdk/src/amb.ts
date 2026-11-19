// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { isAddressEqual, parseAbi, parseEventLogs, type Address, type Hex, type PublicClient, type TransactionReceipt, type WalletClient } from 'viem'

/** The parts of the Gnosis AMB (Home on Chiado, Foreign on Sepolia) and its Helper that the keeper calls. */
export const ambAbi = parseAbi([
  'function requireToPassMessage(address executor, bytes data, uint256 gas) returns (bytes32)',
  'function messageSender() view returns (address)',
  'function maxGasPerTx() view returns (uint256)',
  'function getSignatures(bytes message) view returns (bytes)',
  'function executeSignatures(bytes data, bytes signatures)',
  'event UserRequestForSignature(bytes32 indexed messageId, bytes encodedData)',
  'event UserRequestForAffirmation(bytes32 indexed messageId, bytes encodedData)',
])

/** A Home→Foreign message waiting for its signatures. */
export type HomeMessage = { messageId: Hex; encodedData: Hex }

/**
 * The message a Chiado transaction handed to the Home AMB (`UserRequestForSignature`) that carries `data` (the `_data`
 * the sender passed to `requireToPassMessage`); `undefined` if it sent none. Only logs of `homeAmb` count, and the
 * payload is matched because the transaction may hold other requests, and the AMB pads or packs `encodedData` around
 * `data`.
 */
export const homeMessageFromReceipt = (receipt: TransactionReceipt, homeAmb: Address, data: Hex): HomeMessage | undefined => {
  const wanted = data.slice(2).toLowerCase()
  const logs = receipt.logs.filter((log) => isAddressEqual(log.address, homeAmb))
  const found = parseEventLogs({ abi: ambAbi, eventName: 'UserRequestForSignature', logs }).find((log) => log.args.encodedData.toLowerCase().includes(wanted))

  return found && { messageId: found.args.messageId, encodedData: found.args.encodedData }
}

/**
 * The validators' signatures of `message`, packed as the Foreign AMB takes them; `undefined` while the validators have
 * not signed it (the Helper reverts "message hasn't been confirmed").
 */
export const getSignatures = async (chiado: PublicClient, helper: Address, message: Hex): Promise<Hex | undefined> => {
  try {
    return await chiado.readContract({ address: helper, abi: ambAbi, functionName: 'getSignatures', args: [message] })
  } catch (error) {
    if (String((error as Error).message).includes("hasn't been confirmed")) return undefined
    throw error
  }
}

/** Deliver a Home→Foreign message on Sepolia. Permissionless: the Foreign AMB checks the signatures. */
export const executeSignatures = async (
  wallet: WalletClient,
  sepolia: PublicClient,
  foreignAmb: Address,
  message: Hex,
  signatures: Hex,
): Promise<Hex> => {
  const { request } = await sepolia.simulateContract({
    address: foreignAmb,
    abi: ambAbi,
    functionName: 'executeSignatures',
    args: [message, signatures],
    account: wallet.account,
  })

  return wallet.writeContract(request)
}
