// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import hre from 'hardhat'
import {
  type AztecBridge,
  localAztecBridge,
  readCrispDeployment,
  readDeployment,
  SEPOLIA_AZTEC,
  storeDeployment,
} from './networks'

/** Same minimum as `CRISPProgram`: voting must last an hour, and start after the worst-case committee setup. */
const MIN_VOTING_DURATION = 3600n
/**
 * Aztec testnet: the rollup accepts an epoch proof up to two epochs after the epoch ends, and the ROOT message is
 * only consumable once that proof lands in the Outbox. Two proof windows plus margin, so that a root submitted at the
 * end of the window still lands before Interfold's compute deadline.
 */
const SEPOLIA_REMOTE_FINALITY_WINDOW = 10_800n
const interfoldAbi = [
  'function owner() view returns (address)',
  'function e3Programs(address) view returns (bool)',
  'function registerE3Program(address)',
  'function getCiphertextVerifier(bytes32) view returns (address)',
]

/** The first of `names` the CRISP deploy recorded for `chain` that has code on this chain. */
async function recordedContract(ethers: any, chain: string, names: string[], what: string): Promise<string> {
  const live: string[] = []
  for (const name of names) {
    const record = readCrispDeployment(chain, name)
    if (record && (await ethers.provider.getCode(record.address)) !== '0x') live.push(record.address)
  }
  if (live.length !== 1) {
    throw new Error(
      `Expected exactly one deployed ${what} (${names.join(' or ')}) recorded by the CRISP deploy for ${chain}, found ${live.length}. ` +
        'Run the CRISP deploy first, or set the address through the environment.',
    )
  }
  return live[0]
}

/**
 * Deploys `CRISPAztecProgram` next to an existing Interfold + CRISP stack and registers it with Interfold.
 *
 * Environment (all optional unless stated):
 * - `OPENVM_RECEIPT_VERIFIER`, `DATA_AVAILABILITY_VERIFIER`, `INTERFOLD_ADDRESS`: override the CRISP deploy record.
 * - `AZTEC_NODE_URL` (localhost only, default http://localhost:8080): where to read the Inbox/Outbox/version.
 * - `MIN_VOTING_DURATION`: seconds; 0 disables the timing checks (local network only). Default: 0 on localhost, 3600 on Sepolia.
 * - `CRISP_REMOTE_FINALITY_WINDOW`: seconds Interfold's compute window must cover for the Aztec round to close and settle
 *   (`validate` reverts below it); 0 disables the check. Default: 0 on localhost, 10800 on Sepolia.
 * - `CRISP_AZTEC_L2_ADDRESS`: Aztec address of the deployed `crisp_aztec` contract; set once on the program.
 * - `CRISP_INITIAL_OWNER`: owner of the program (default: deployer). Required on Sepolia when governance owns Interfold.
 * - `REDEPLOY=true`: deploy a new program even if one is recorded for this network.
 *
 * The L2 contract takes this program's address as an immutable and this program takes the L2 address afterwards, so
 * the intended order is: run this script, deploy `crisp_aztec` with the printed L1 address, run this script again with
 * `CRISP_AZTEC_L2_ADDRESS`. A rerun reuses the recorded program.
 */
export async function deploy(): Promise<void> {
  const { ethers } = await hre.network.connect()
  const [deployer] = await ethers.getSigners()
  const deployerAddress = await deployer.getAddress()
  const chain = hre.globalOptions.network ?? 'localhost'
  const chainId = (await ethers.provider.getNetwork()).chainId
  if (chain !== 'localhost' && chain !== 'sepolia') throw new Error(`Unsupported network ${chain}; use localhost or sepolia`)
  if (chain === 'sepolia' && chainId !== 11155111n) throw new Error(`Network sepolia is chain ${chainId}, expected 11155111`)

  const bridge: AztecBridge =
    chain === 'sepolia' ? SEPOLIA_AZTEC : await localAztecBridge(process.env.AZTEC_NODE_URL ?? 'http://localhost:8080')

  const interfoldAddress = process.env.INTERFOLD_ADDRESS ?? (await recordedContract(ethers, chain, ['Interfold'], 'Interfold'))
  const verifier =
    process.env.OPENVM_RECEIPT_VERIFIER ??
    (await recordedContract(ethers, chain, ['OpenVmReceiptVerifier', 'MockOpenVmReceiptVerifier'], 'OpenVM receipt verifier'))
  const dataAvailability =
    process.env.DATA_AVAILABILITY_VERIFIER ??
    (await recordedContract(
      ethers,
      chain,
      ['MockCrispDataAvailabilityVerifier', 'AvailVectorXDataAvailabilityVerifier'],
      'data-availability verifier',
    ))

  // A local network runs rounds that last minutes, so the timing checks are off there unless asked for.
  const minVotingDuration = process.env.MIN_VOTING_DURATION
    ? BigInt(process.env.MIN_VOTING_DURATION)
    : chain === 'sepolia'
      ? MIN_VOTING_DURATION
      : 0n
  if (chain === 'sepolia' && minVotingDuration < MIN_VOTING_DURATION) {
    throw new Error('MIN_VOTING_DURATION below one hour is only for the local network')
  }
  const remoteFinalityWindow = process.env.CRISP_REMOTE_FINALITY_WINDOW
    ? BigInt(process.env.CRISP_REMOTE_FINALITY_WINDOW)
    : chain === 'sepolia'
      ? SEPOLIA_REMOTE_FINALITY_WINDOW
      : 0n
  const initialOwner = process.env.CRISP_INITIAL_OWNER ? ethers.getAddress(process.env.CRISP_INITIAL_OWNER) : deployerAddress

  const receiptVerifier = new ethers.Contract(verifier, ['function imageId() view returns (bytes32)'], deployer)

  const recorded = readDeployment(chain, 'CRISPAztecProgram')
  let programAddress: string
  if (recorded && process.env.REDEPLOY !== 'true' && (await ethers.provider.getCode(recorded.address)) !== '0x') {
    programAddress = recorded.address
    console.log(`Reusing CRISPAztecProgram ${programAddress}`)
  } else {
    const program = await ethers.deployContract(
      'CRISPAztecProgram',
      [
        initialOwner,
        verifier,
        await receiptVerifier.imageId(),
        dataAvailability,
        minVotingDuration,
        remoteFinalityWindow,
        bridge.inbox,
        bridge.outbox,
        bridge.rollupVersion,
      ],
      deployer,
    )
    await program.waitForDeployment()
    programAddress = await program.getAddress()
    const receipt = await program.deploymentTransaction()!.wait()
    storeDeployment(chain, 'CRISPAztecProgram', {
      address: programAddress,
      blockNumber: receipt!.blockNumber,
      constructorArgs: {
        initialOwner,
        openVmVerifier: verifier,
        imageId: await receiptVerifier.imageId(),
        dataAvailabilityVerifier: dataAvailability,
        minVotingDuration: minVotingDuration.toString(),
        remoteFinalityWindow: remoteFinalityWindow.toString(),
        inbox: bridge.inbox,
        outbox: bridge.outbox,
        rollupVersion: bridge.rollupVersion.toString(),
      },
    })
  }
  const program = await ethers.getContractAt('CRISPAztecProgram', programAddress, deployer)

  // Register with Interfold and bind, as the CRISP deploy does for CRISPProgram. Governance-owned Interfolds
  // (Sepolia, mainnet) need the same two calls from their owner.
  const interfold = new ethers.Contract(interfoldAddress, interfoldAbi, deployer)
  const owner = await program.owner()
  let wired = (await interfold.e3Programs(programAddress)) && (await program.interfold()) !== ethers.ZeroAddress
  if (!wired) {
    const interfoldOwner = await interfold.owner()
    if (interfoldOwner.toLowerCase() === deployerAddress.toLowerCase() && owner.toLowerCase() === deployerAddress.toLowerCase()) {
      if (!(await interfold.e3Programs(programAddress))) await (await interfold.registerE3Program(programAddress)).wait()
      if ((await program.interfold()) === ethers.ZeroAddress) await (await program.bindInterfold(interfoldAddress)).wait()
      wired = true
    } else {
      console.log(
        `Interfold registration is incomplete: Interfold owner ${interfoldOwner} must call registerE3Program(${programAddress}), ` +
          `then program owner ${owner} must call bindInterfold(${interfoldAddress}).`,
      )
    }
  }
  if (wired && (await interfold.getCiphertextVerifier(ethers.id('fhe.rs:BFV'))) === ethers.ZeroAddress) {
    console.log('Interfold has no ciphertext verifier for fhe.rs:BFV yet; the CRISP deploy sets it.')
  }

  const l2 = process.env.CRISP_AZTEC_L2_ADDRESS
  if (l2 && (await program.l2Program()) === ethers.ZeroHash) {
    if (owner.toLowerCase() !== deployerAddress.toLowerCase()) {
      console.log(`The program owner ${owner} must call setL2Program(${l2}).`)
    } else {
      await (await program.setL2Program(l2)).wait()
    }
  }

  console.log(`
      CRISPAztecProgram deployment (${chain}):
      ----------------------------------------------------------------------
      CRISPAztecProgram: ${programAddress}
      Interfold: ${interfoldAddress}
      OpenVM receipt verifier: ${verifier}
      Data availability verifier: ${dataAvailability}
      Aztec Inbox: ${bridge.inbox}
      Aztec Outbox: ${bridge.outbox}
      Rollup version: ${bridge.rollupVersion}
      L2 program: ${await program.l2Program()}
      CRISP_AZTEC_L1_PROGRAM=${programAddress}
  `)
}

deploy().catch((err) => {
  console.error(err)
  process.exit(1)
})
