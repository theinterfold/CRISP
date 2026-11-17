// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

// Sends real ROUND and KEY messages through the Inbox of a running Aztec local network and reads them back from the
// Inbox's own event: the Inbox, not a test double, decides whether the actor, content and secret hash are acceptable.
// Interfold, the OpenVM verifier and the data-availability verifier are the test doubles from `contracts/test`.
//
//   aztec start --local-network     # node :8080, anvil :8545
//   pnpm -C extensions/aztec/l1 check:network
//
// Consuming an L2 -> L1 ROOT message needs a closed round on the L2 contract; that part is exercised by the end-to-end
// flow (`extensions/aztec/keeper`), not here.
import hre from 'hardhat'
import { localAztecBridge } from '../deploy/networks'

const L2_PROGRAM = '0x0000000000000000000000000000000000000000000000000000000000c0ffee'

const inboxAbi = [
  'function VERSION() view returns (uint256)',
  'function getTotalMessagesInserted() view returns (uint64)',
  'event MessageSent(bytes32 indexed hash, bytes32 inboxRollingHash, uint256 bucketSeq, (tuple(address actor, uint256 chainId) sender, tuple(bytes32 actor, uint256 version) recipient, bytes32 content, bytes32 secretHash, uint256 index) message)',
]

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`check failed: ${message}`)
}

async function main() {
  const { ethers } = await hre.network.connect()
  const [deployer] = await ethers.getSigners()
  const bridge = await localAztecBridge(process.env.AZTEC_NODE_URL ?? 'http://localhost:8080')
  const inbox = new ethers.Contract(bridge.inbox, inboxAbi, deployer)
  assert((await inbox.VERSION()) === bridge.rollupVersion, 'Inbox version equals the node rollup version')

  const receiptVerifier = await ethers.deployContract('MockOpenVmReceiptVerifier')
  const dataAvailability = await ethers.deployContract('MockDataAvailabilityVerifier')
  const interfold = await ethers.deployContract('MockInterfold')
  const program = await ethers.deployContract('CRISPAztecProgram', [
    await deployer.getAddress(),
    await receiptVerifier.getAddress(),
    await receiptVerifier.imageId(),
    await dataAvailability.getAddress(),
    0n,
    0n,
    bridge.inbox,
    bridge.outbox,
    bridge.rollupVersion,
  ])
  await (await interfold.registerE3Program(await program.getAddress())).wait()
  await (await program.bindInterfold(await interfold.getAddress())).wait()
  await (await program.setL2Program(L2_PROGRAM)).wait()

  const now = (await ethers.provider.getBlock('latest'))!.timestamp
  // numOptions, credits, minAge, allowMockDocuments, registrar (none: voters register on Aztec), nationalityMode, countries, commitment
  const customParams = ethers.AbiCoder.defaultAbiCoder().encode(
    ['uint256', 'uint256', 'uint256', 'bool', 'address', 'uint8', 'string[]', 'uint256'],
    [3, 100, 18, true, ethers.ZeroAddress, 0, [], 0],
  )
  const before = await inbox.getTotalMessagesInserted()
  const programAddress = await program.getAddress()
  const e3Id = await interfold.request.staticCall(programAddress, [now + 600, now + 4200], customParams)
  const round = await (await interfold.request(programAddress, [now + 600, now + 4200], customParams)).wait()

  const sent = round!.logs.flatMap((log: any) => {
    try {
      const parsed = inbox.interface.parseLog(log)
      return parsed?.name === 'MessageSent' ? [parsed] : []
    } catch {
      return []
    }
  })
  assert(sent.length === 1, 'validate inserted exactly one Inbox message')
  const { message } = sent[0].args
  assert(message.sender.actor === programAddress, 'sender is the L1 program')
  assert(message.recipient.actor === L2_PROGRAM && message.recipient.version === bridge.rollupVersion, 'recipient is the L2 program')
  assert(message.secretHash === (await program.SECRET_HASH()), 'secret hash is the constant secret-0 hash')
  assert((await inbox.getTotalMessagesInserted()) === before + 1n, 'Inbox message count advanced by one')
  console.log(`ROUND e3Id=${e3Id} leaf=${sent[0].args.hash} index=${message.index} content=${message.content}`)

  await (await interfold.setCommitteePublicKey(e3Id, ethers.id('committee key'))).wait()
  await (await interfold.setStage(e3Id, 3)).wait()
  const key = await (await program.publishCommitteeKey(e3Id)).wait()
  const keyMessage = key!.logs.flatMap((log: any) => {
    try {
      const parsed = inbox.interface.parseLog(log)
      return parsed?.name === 'MessageSent' ? [parsed] : []
    } catch {
      return []
    }
  })
  assert(keyMessage.length === 1, 'publishCommitteeKey inserted exactly one Inbox message')
  console.log(`KEY   e3Id=${e3Id} leaf=${keyMessage[0].args.hash} index=${keyMessage[0].args.message.index}`)
  console.log('Aztec Inbox accepted the ROUND and KEY messages.')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
