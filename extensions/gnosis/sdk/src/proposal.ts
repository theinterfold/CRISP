// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { concat, encodeAbiParameters, encodePacked, keccak256, numberToHex, type Address, type Hex } from 'viem'

/** One call of a proposal's Safe batch. */
export type BatchCall = { to: Address; value?: bigint; data?: Hex }

/**
 * The calls of a proposal in the MultiSend encoding, and the hash a round binds them with.
 *
 * Each call is `operation (1 byte) ‖ to (20) ‖ value (32) ‖ dataLength (32) ‖ data`. The operation is always `0` (call):
 * the batch runs through `MultiSendCallOnly`, which refuses delegate calls. `proposalHash = keccak256(packed)` is what
 * `CrispGovernanceModule.executeProposal` compares with the round's hash before it runs `packed`.
 */
export const packBatch = (calls: readonly BatchCall[]): { packed: Hex; proposalHash: Hex } => {
  if (calls.length === 0) throw new Error('A proposal needs at least one call')
  const packed = concat(
    calls.map(({ to, value = 0n, data = '0x' }) =>
      encodePacked(['uint8', 'address', 'uint256', 'uint256', 'bytes'], [0, to, value, BigInt((data.length - 2) / 2), data]),
    ),
  )

  return { packed, proposalHash: keccak256(packed) }
}

/**
 * `Interfold.request`'s `customParams` for `CRISPGnosisProgram`:
 * `abi.encode(censusMode, censusRoot, censusTotal, proposalHash, metadataCid)`. Phase 1 has one census, the token's
 * voting power at the request, so the first three are zero.
 */
export const encodeCustomParams = (args: { proposalHash: Hex; metadataCid: string }): Hex => {
  const length = new TextEncoder().encode(args.metadataCid).length
  if (length < 1 || length > 128) throw new Error('The metadata CID must be 1 to 128 bytes')
  if (BigInt(args.proposalHash) === 0n) throw new Error('The proposal hash must not be zero')

  return encodeAbiParameters(
    [{ type: 'uint8' }, { type: 'bytes32' }, { type: 'uint256' }, { type: 'bytes32' }, { type: 'string' }],
    [0, numberToHex(0n, { size: 32 }), 0n, args.proposalHash, args.metadataCid],
  )
}

/**
 * bincode of the compute provider settings the CRISP server expects (`{ name, parallel, batch_size }`): a little-endian
 * u64 length and the name, a bool, and a little-endian u32.
 */
export const encodeComputeProviderParams = ({ name = 'OpenVM', parallel = false, batchSize = 4 } = {}): Hex => {
  const bytes = new TextEncoder().encode(name)
  const out = new Uint8Array(8 + bytes.length + 1 + 4)
  const view = new DataView(out.buffer)
  view.setBigUint64(0, BigInt(bytes.length), true)
  out.set(bytes, 8)
  out[8 + bytes.length] = parallel ? 1 : 0
  view.setUint32(8 + bytes.length + 1, batchSize, true)

  return `0x${Buffer.from(out).toString('hex')}`
}

/** The argument of `Interfold.request` / `getE3Quote`. */
export type E3RequestParams = {
  committeeSize: number
  inputWindow: readonly [bigint, bigint]
  e3Program: Address
  paramSet: number
  computeProviderParams: Hex
  customParams: Hex
  expectedFeeToken: Address
  expectedCryptoConfigId: Hex
  maxFee: bigint
}

/**
 * Build the `Interfold.request` argument of a proposal. `maxFee` is the ceiling the proposer accepts: quote the fee
 * with `getE3Quote` first (`maxFee: 2n ** 255n`) and pass the result.
 */
export const buildRequest = (args: {
  /** `CRISPGnosisProgram`. */
  program: Address
  /** The voting window. `inputStart` must not be earlier than the program's `earliestVotingStart()`. */
  inputStart: bigint
  inputEnd: bigint
  proposalHash: Hex
  metadataCid: string
  feeToken: Address
  /** `Interfold.activeCryptoConfigId()`, or the insecure id for param set 0. */
  cryptoConfigId: Hex
  maxFee: bigint
  committeeSize: number
  paramSet: number
  computeProviderParams?: Hex
}): E3RequestParams => ({
  committeeSize: args.committeeSize,
  inputWindow: [args.inputStart, args.inputEnd],
  e3Program: args.program,
  paramSet: args.paramSet,
  computeProviderParams: args.computeProviderParams ?? encodeComputeProviderParams(),
  customParams: encodeCustomParams({ proposalHash: args.proposalHash, metadataCid: args.metadataCid }),
  expectedFeeToken: args.feeToken,
  expectedCryptoConfigId: args.cryptoConfigId,
  maxFee: args.maxFee,
})
