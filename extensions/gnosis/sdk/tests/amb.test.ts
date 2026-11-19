// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { encodeAbiParameters, encodeEventTopics, type Hex, type TransactionReceipt } from 'viem'
import { describe, expect, it } from 'vitest'

import { ambAbi, homeMessageFromReceipt } from '../src/amb'
import { encodeReceiveMessage, encodeRootMessage } from '../src/messages'

const HOME = '0xf220FcE239506963bdc70864102E6fb6cEaED8Cf'
const OTHER = '0x3333333333333333333333333333333333333333'

/** A `UserRequestForSignature` log shaped like MockAMB's: `abi.encode(messageId, sender, executor, gas, data)`. */
const request = (address: string, messageId: Hex, data: Hex) => ({
  address,
  topics: encodeEventTopics({ abi: ambAbi, eventName: 'UserRequestForSignature', args: { messageId } }),
  data: encodeAbiParameters(
    [{ type: 'bytes' }],
    [encodeAbiParameters([{ type: 'bytes32' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'bytes' }], [messageId, OTHER, OTHER, 150_000n, data])],
  ),
})

const receipt = (...logs: ReturnType<typeof request>[]) => ({ logs: logs.map((log, logIndex) => ({ ...log, logIndex })) }) as unknown as TransactionReceipt

describe('homeMessageFromReceipt', () => {
  const root = encodeReceiveMessage(encodeRootMessage(7n, 123n, 4n))
  const decoy = encodeReceiveMessage(encodeRootMessage(7n, 999n, 4n))
  const id = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}`

  it('picks the request that carries the expected payload among decoys', () => {
    const logs = [request(HOME, id(1), decoy), request(OTHER, id(2), root), request(HOME, id(3), root)]
    expect(homeMessageFromReceipt(receipt(...logs), HOME, root)?.messageId).toBe(id(3))
  })

  it('ignores requests of other contracts, even with the right payload', () => {
    expect(homeMessageFromReceipt(receipt(request(OTHER, id(2), root)), HOME, root)).toBeUndefined()
  })

  it('returns undefined when no request carries the payload', () => {
    expect(homeMessageFromReceipt(receipt(request(HOME, id(1), decoy)), HOME, root)).toBeUndefined()
  })
})
