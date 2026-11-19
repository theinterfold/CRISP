// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

// The AMB validators of the local stack: delivers every Foreign→Home message (ROUND, KEY, RESULT) to the Home MockAMB.
// Home→Foreign (ROOT) is not delivered here: the keeper carries it with `getSignatures` + `executeSignatures`, as it does on the real AMB.
import { createPublicClient, createWalletClient, getAddress, http, parseAbi, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'

const abi = parseAbi([
  'event UserRequestForAffirmation(bytes32 indexed messageId, bytes encodedData)',
  'function executeAffirmation(bytes encodedData)',
])

const required = (name: string): string => {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)

  return value
}

const rpc = required('RELAYER_RPC_URL')
const foreignAmb = getAddress(required('RELAYER_FOREIGN_AMB'))
const homeAmb = getAddress(required('RELAYER_HOME_AMB'))
const account = privateKeyToAccount(required('RELAYER_PRIVATE_KEY') as Hex)
const pollMs = Number(process.env.RELAYER_POLL_MS ?? 1000)

const client = createPublicClient({ transport: http(rpc) })
const wallet = createWalletClient({ account, transport: http(rpc) })
const log = (message: string) => console.log(`${new Date().toISOString()} ${message}`)

let next = BigInt(process.env.RELAYER_START_BLOCK ?? 0)
const delivered = new Set<Hex>()

const tick = async () => {
  const head = await client.getBlockNumber()
  if (next > head) return
  const logs = await client.getContractEvents({ address: foreignAmb, abi, eventName: 'UserRequestForAffirmation', fromBlock: next, toBlock: head })
  for (const { args } of logs) {
    const { messageId, encodedData } = args as { messageId: Hex; encodedData: Hex }
    if (delivered.has(messageId)) continue
    const { request } = await client.simulateContract({ address: homeAmb, abi, functionName: 'executeAffirmation', args: [encodedData], account })
    const hash = await wallet.writeContract(request)
    await client.waitForTransactionReceipt({ hash })
    delivered.add(messageId)
    log(`delivered ${messageId} to the Home AMB in ${hash}`)
  }
  next = head + 1n
}

for (;;) {
  try {
    await tick()
  } catch (error) {
    log(`pass failed: ${error instanceof Error ? error.message.split('\n')[0] : String(error)}`)
  }
  await new Promise((resolve) => setTimeout(resolve, pollMs))
}
