// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { network } from 'hardhat'
import type { HardhatEthers } from '@nomicfoundation/hardhat-ethers/types'

const connection = await network.connect()
export const ethers: HardhatEthers = connection.ethers
export const abiCoder = ethers.AbiCoder.defaultAbiCoder()

export const ROLLUP_VERSION = 679261766n
/** Aztec's BN254 scalar field; every Inbox actor, content and secret hash must be below it. */
export const FIELD_MODULUS = 21888242871839275222246405745257275088548364400416034343698204186575808495617n
/** The `KeyPublished` value of Interfold's `E3Stage` enum. */
export const STAGE = { Requested: 1, KeyPublished: 3, CiphertextReady: 4, Failed: 6 } as const

export async function latestTimestamp(): Promise<number> {
  return connection.networkHelpers.time.latest()
}

export async function increaseTimeTo(timestamp: number): Promise<void> {
  await connection.networkHelpers.time.increaseTo(timestamp)
}

/** Aztec's `sha256ToField`: the first 31 bytes of the sha256, as a field element. */
export function sha256ToField(data: string): string {
  return ethers.zeroPadValue(ethers.toBeHex(BigInt(ethers.sha256(data)) >> 8n), 32)
}

/** Message leaf of the Aztec L1-to-L2 tree: `sha256ToField(abi.encode(L1ToL2Msg))` (`Hash.sha256ToField`, v6.0.0). */
export function l1ToL2Leaf(msg: {
  sender: { actor: string; chainId: bigint }
  recipient: { actor: string; version: bigint }
  content: string
  secretHash: string
  index: bigint
}): string {
  return sha256ToField(
    abiCoder.encode(
      ['address', 'uint256', 'bytes32', 'uint256', 'bytes32', 'bytes32', 'uint256'],
      [msg.sender.actor, msg.sender.chainId, msg.recipient.actor, msg.recipient.version, msg.content, msg.secretHash, msg.index],
    ),
  )
}

/** Message leaf of the Aztec L2-to-L1 tree (`Hash.sha256ToField(L2ToL1Msg)`, v6.0.0): a packed encoding. */
export function l2ToL1Leaf(l2Program: string, version: bigint, l1Recipient: string, chainId: bigint, content: string): string {
  return sha256ToField(
    ethers.solidityPacked(['bytes32', 'uint256', 'address', 'uint256', 'bytes32'], [l2Program, version, l1Recipient, chainId, content]),
  )
}

/** Binary Aztec out-hash tree (sha256ToField of concatenated children); returns the root and a sibling path per leaf. */
export function outboxTree(leaves: string[]): { root: string; path: (index: number) => string[] } {
  if ((leaves.length & (leaves.length - 1)) !== 0) throw new Error('test helper needs a power-of-two number of leaves')
  const layers: string[][] = [leaves]
  while (layers[layers.length - 1].length > 1) {
    const prev = layers[layers.length - 1]
    const next: string[] = []
    for (let i = 0; i < prev.length; i += 2) next.push(sha256ToField(ethers.concat([prev[i], prev[i + 1]])))
    layers.push(next)
  }
  return {
    root: layers[layers.length - 1][0],
    path: (index) => layers.slice(0, -1).map((layer, height) => layer[(index >> height) ^ 1]),
  }
}

const require = createRequire(import.meta.url)

/** Deploy the real, v6.0.0-compiled Aztec contract from `@aztec-foundation/l1-artifacts`. */
async function deployAztec(name: 'Inbox' | 'Outbox', args: unknown[]) {
  const artifact = JSON.parse(
    readFileSync(require.resolve(`@aztec-foundation/l1-artifacts/l1-contracts/out/${name}.sol/${name}.json`), 'utf8'),
  )
  const [signer] = await ethers.getSigners()
  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode.object, signer)
  const contract = await factory.deploy(...args)
  await contract.waitForDeployment()
  return contract
}

export interface Fixture {
  program: any
  inbox: any
  outbox: any
  interfold: any
  receiptVerifier: any
  dataAvailability: any
  /** Plays the Aztec rollup: the only account the real Outbox lets insert epoch roots. */
  rollup: any
  l2Program: string
}

export const L2_PROGRAM = '0x1c0a1f5b3a8bd1a8f6bd3d7e0c7d5c0bd1d6d9c3d6a3b6e4f3a2b1c0d9e8f7a6'

export async function deployFixture(
  options: { minVotingDuration?: bigint; remoteFinalityWindow?: bigint; setL2Program?: boolean; bind?: boolean } = {},
): Promise<Fixture> {
  const { minVotingDuration = 0n, remoteFinalityWindow = 0n, setL2Program = true, bind = true } = options
  const [owner, , , , , rollup] = await ethers.getSigners()

  // The Inbox needs a rollup address and a fee asset only for its fee-juice portal; neither is exercised here.
  const inbox = await deployAztec('Inbox', [await rollup.getAddress(), await owner.getAddress(), ROLLUP_VERSION, 512])
  const outbox = await deployAztec('Outbox', [await rollup.getAddress(), ROLLUP_VERSION])

  const receiptVerifier = await ethers.deployContract('MockOpenVmReceiptVerifier')
  const dataAvailability = await ethers.deployContract('MockDataAvailabilityVerifier')
  const interfold = await ethers.deployContract('MockInterfold')
  const program = await ethers.deployContract('CRISPAztecProgram', [
    await owner.getAddress(),
    await receiptVerifier.getAddress(),
    await receiptVerifier.imageId(),
    await dataAvailability.getAddress(),
    minVotingDuration,
    remoteFinalityWindow,
    await inbox.getAddress(),
    await outbox.getAddress(),
    ROLLUP_VERSION,
  ])

  await (await interfold.registerE3Program(await program.getAddress())).wait()
  if (bind) await (await program.bindInterfold(await interfold.getAddress())).wait()
  if (setL2Program) await (await program.setL2Program(L2_PROGRAM)).wait()

  return { program, inbox, outbox, interfold, receiptVerifier, dataAvailability, rollup, l2Program: L2_PROGRAM }
}

export interface CustomParamsInput {
  numOptions?: bigint
  credits?: bigint
  minAge?: bigint
  allowMockDocuments?: boolean
  /** 0 none, 1 nationality in `countries`, 2 nationality not in `countries`. */
  nationalityMode?: number
  countries?: string[]
  nationalityCommitment?: bigint
}

/** `abi.encode(numOptions, credits, minAge, allowMockDocuments, nationalityMode, countries, nationalityCommitment)`. */
export function customParams(p: CustomParamsInput = {}): string {
  const {
    numOptions = 3n,
    credits = 100n,
    minAge = 18n,
    allowMockDocuments = true,
    nationalityMode = 0,
    countries = [],
    nationalityCommitment = 0n,
  } = p
  return abiCoder.encode(
    ['uint256', 'uint256', 'uint256', 'bool', 'uint8', 'string[]', 'uint256'],
    [numOptions, credits, minAge, allowMockDocuments, nationalityMode, countries, nationalityCommitment],
  )
}

/** A window that starts shortly after the latest block and lasts an hour. */
export async function defaultWindow(): Promise<[number, number]> {
  const now = await latestTimestamp()
  return [now + 600, now + 600 + 3600]
}
