// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { decodeFunctionData, toFunctionSelector } from 'viem'
import { describe, expect, it } from 'vitest'

import { registerOnL1Calldata, registrarAbi } from '../src/registrar'
import { relayRegistrationOnL1 } from '../src/server'

const params = {
  version: `0x${'01'.repeat(32)}`,
  proofVerificationData: { vkeyHash: `0x${'02'.repeat(32)}`, proof: '0xabcdef', publicInputs: [`0x${'03'.repeat(32)}`, `0x${'04'.repeat(32)}`] },
  committedInputs: '0x0102',
  serviceConfig: { validityPeriodInSeconds: 604800n, domain: 'poll.theinterfold.com', scope: 'ignored', devMode: false },
} as const

const slot = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'

describe('registerOnL1Calldata', () => {
  it('encodes ZKPassportRegistrar.register(uint256,address,ProofVerificationParams,string[])', () => {
    const calldata = registerOnL1Calldata({ e3Id: 42n, slot, params, countries: ['DEU', 'FRA'] })
    expect(calldata.slice(0, 10)).toBe(
      toFunctionSelector(
        'register(uint256,address,(bytes32,(bytes32,bytes,bytes32[]),bytes,(uint256,string,string,bool)),string[])',
      ),
    )
    const { functionName, args } = decodeFunctionData({ abi: registrarAbi, data: calldata })
    expect(functionName).toBe('register')
    expect(args?.[0]).toBe(42n)
    expect(args?.[1]).toBe(slot)
    expect(args?.[2]).toEqual({ ...params, proofVerificationData: { ...params.proofVerificationData, publicInputs: [...params.proofVerificationData.publicInputs] } })
    expect(args?.[3]).toEqual(['DEU', 'FRA'])
  })
})

describe('relayRegistrationOnL1', () => {
  it('posts the calldata to /registration/l1 and returns the transaction hash', async () => {
    const calls: { url: string; body: unknown }[] = []
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: JSON.parse(init.body as string) })

      return new Response(JSON.stringify({ txHash: `0x${'ab'.repeat(32)}` }), { status: 200 })
    }) as unknown as typeof fetch

    expect(await relayRegistrationOnL1('http://server', '0x1234', fetchImpl)).toEqual({ txHash: `0x${'ab'.repeat(32)}` })
    expect(calls).toEqual([{ url: 'http://server/registration/l1', body: { calldata: '0x1234' } }])
  })

  it('surfaces the revert reason of a refused registration', async () => {
    const fetchImpl = (async () => new Response('execution reverted: AgeNotProven(18)', { status: 400 })) as unknown as typeof fetch
    await expect(relayRegistrationOnL1('http://server', '0x1234', fetchImpl)).rejects.toThrow(/400.*AgeNotProven/)
  })
})
