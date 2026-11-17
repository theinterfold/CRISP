// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { Fr } from '@aztec-labs/foundation/curves/bn254'
import { EthAddress } from '@aztec-labs/foundation/eth-address'
import { computeL2ToL1MessageHash } from '@aztec-labs/stdlib/hash'
import type { AztecAddress } from '@aztec-labs/stdlib/aztec-address'
import type { AztecNode } from '@aztec-labs/stdlib/interfaces/client'
import { TxHash } from '@aztec-labs/stdlib/tx'
import { numberToHex, type Address } from 'viem'

import type { RootWitness } from './l1'
import { rootContent, roundIdOf } from './messages'

/**
 * The Outbox witness of the ROOT message `close_round` sent, or `undefined` while the Outbox has no root that covers it.
 *
 * The node builds the witness against the smallest partial-proof root already on L1, so this is empty until the
 * epoch's proof (or a covering partial proof) has landed; a keeper simply asks again later.
 */
export const getRootWitness = async (
  node: AztecNode,
  args: {
    closeTx: string
    contract: AztecAddress
    program: Address
    l1ChainId: number
    rollupVersion: number
    e3Id: bigint
    inputRoot: bigint
    numInputs: bigint
  },
): Promise<RootWitness | undefined> => {
  const message = computeL2ToL1MessageHash({
    l2Sender: args.contract,
    l1Recipient: EthAddress.fromString(args.program),
    content: new Fr(rootContent(roundIdOf(args.e3Id), args.inputRoot, args.numInputs)),
    rollupVersion: new Fr(args.rollupVersion),
    chainId: new Fr(args.l1ChainId),
  })
  const witness = await node.getL2ToL1MembershipWitness(TxHash.fromString(args.closeTx), message)
  if (!witness) return undefined

  return {
    epoch: BigInt(witness.epochNumber),
    numCheckpointsInEpoch: BigInt(witness.numCheckpointsInEpoch),
    leafIndex: witness.leafIndex,
    path: witness.siblingPath.toFields().map((field) => numberToHex(field.toBigInt(), { size: 32 })),
  }
}
