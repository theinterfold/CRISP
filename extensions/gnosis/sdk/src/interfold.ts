// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { parseAbi, parseEventLogs, type Address, type Hex, type PublicClient, type WalletClient } from 'viem'

import type { E3RequestParams } from './proposal'

const REQUEST = '(uint8 committeeSize, uint256[2] inputWindow, address e3Program, uint8 paramSet, bytes computeProviderParams, bytes customParams, address expectedFeeToken, bytes32 expectedCryptoConfigId, uint256 maxFee)'
const E3 =
  '(uint256 seed, uint8 committeeSize, uint256 requestBlock, uint256[2] inputWindow, bytes32 encryptionSchemeId, address e3Program, uint8 paramSet, bytes customParams, address decryptionVerifier, address pkVerifier, bytes32 committeePublicKey, bytes32 ciphertextOutput, bytes plaintextOutput, address requester, bytes32 ciphertextCommitment)'

/** The part of the Interfold controller this package calls or reads. */
export const interfoldAbi = parseAbi([
  `function request(${REQUEST} params) returns (uint256 e3Id, ${E3} e3)`,
  `function getE3Quote(${REQUEST} params) view returns (uint256 fee)`,
  'function getE3Stage(uint256 e3Id) view returns (uint8)',
  `function getE3(uint256 e3Id) view returns (${E3})`,
  'function activeCryptoConfigId() view returns (bytes32)',
  'function feeToken() view returns (address)',
  `event E3Requested(uint256 e3Id, ${E3} e3, bytes32 indexed cryptoConfigId)`,
])

const erc20Abi = parseAbi([
  'function approve(address spender, uint256 amount) returns (bool)',
  'function allowance(address owner, address spender) view returns (uint256)',
])

/** The fee Interfold charges for a proposal's round. */
export const quoteFee = (sepolia: PublicClient, interfold: Address, params: E3RequestParams): Promise<bigint> =>
  sepolia.readContract({ address: interfold, abi: interfoldAbi, functionName: 'getE3Quote', args: [{ ...params, inputWindow: [...params.inputWindow] }] })

/**
 * Request a proposal's round: approve the fee if the allowance is short, then `Interfold.request`. The proposer pays
 * the fee token and the Sepolia gas. `params.maxFee` must cover the fee (`quoteFee`).
 */
export const requestRound = async (
  wallet: WalletClient,
  sepolia: PublicClient,
  interfold: Address,
  params: E3RequestParams,
): Promise<{ e3Id: bigint; txHash: Hex }> => {
  const account = wallet.account!
  const allowance = await sepolia.readContract({
    address: params.expectedFeeToken,
    abi: erc20Abi,
    functionName: 'allowance',
    args: [account.address, interfold],
  })
  if (allowance < params.maxFee) {
    const approval = await wallet.writeContract({
      address: params.expectedFeeToken,
      abi: erc20Abi,
      functionName: 'approve',
      args: [interfold, params.maxFee],
      account,
      chain: wallet.chain,
    })
    await sepolia.waitForTransactionReceipt({ hash: approval })
  }

  const { request } = await sepolia.simulateContract({
    address: interfold,
    abi: interfoldAbi,
    functionName: 'request',
    args: [{ ...params, inputWindow: [...params.inputWindow] }],
    account,
  })
  const txHash = await wallet.writeContract(request)
  const receipt = await sepolia.waitForTransactionReceipt({ hash: txHash })
  if (receipt.status !== 'success') throw new Error(`Interfold.request reverted in ${txHash}`)
  const [requested] = parseEventLogs({ abi: interfoldAbi, eventName: 'E3Requested', logs: receipt.logs })
  if (!requested) throw new Error(`Interfold.request in ${txHash} emitted no E3Requested`)

  return { e3Id: requested.args.e3Id, txHash }
}
