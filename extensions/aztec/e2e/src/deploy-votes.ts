// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

// Deploy `CrispAztecVotes` on a live Aztec network, for a `CRISPAztecVotesProgram` already on L1.
//
//   CRISP_AZTEC_L1_PROGRAM=0x… INTERFOLD_ADDRESS=0x… AVAILABILITY_SIGNER_PUBLIC_KEY=0x<64 bytes> \
//   AZTEC_NODE_URL=https://… pnpm deploy:votes
//
// The deployer is a throwaway account whose fees the network's SponsoredFPC pays. The contract pins the verification keys of
// the insecure-64 base circuits. It prints the contract address and the Aztec block to scan from; then set the program's
// `l2Program` (`CRISP_AZTEC_L2_ADDRESS=… CRISP_AZTEC_KIND=votes pnpm deploy:sepolia` in `../l1`).

import { connectAztec, deployCrispAztecVotes, domainSeparator, getBaseVerificationKeys } from '@crisp-e3/aztec'
import { destroyBBApi, setCircuits } from '@crisp-e3/sdk'
import { loadCircuits } from '@crisp-e3/sdk/insecure-64'
import { getAddress, isHex, type Hex } from 'viem'

const required = (name: string): string => {
  const value = process.env[name]?.trim()
  if (!value) throw new Error(`${name} is required`)
  return value
}

const program = getAddress(required('CRISP_AZTEC_L1_PROGRAM'))
const interfold = getAddress(required('INTERFOLD_ADDRESS'))
const signerKey = required('AVAILABILITY_SIGNER_PUBLIC_KEY') as Hex
if (!isHex(signerKey)) throw new Error('AVAILABILITY_SIGNER_PUBLIC_KEY must be hex')

setCircuits(await loadCircuits())
const keys = await getBaseVerificationKeys()
destroyBBApi()

const session = await connectAztec(required('AZTEC_NODE_URL'))
try {
  const startBlock = await session.node.getBlockNumber()
  const contract = await deployCrispAztecVotes(session, {
    l1Program: program,
    interfold,
    domainSeparator: domainSeparator(session.l1ChainId, program),
    availabilitySignerPublicKey: signerKey,
    ct0VkHash: BigInt(keys.ct0.vkHash),
    ct1VkHash: BigInt(keys.ct1.vkHash),
    crispVkHash: BigInt(keys.crisp.vkHash),
  })
  console.log(`CRISP_AZTEC_L2_ADDRESS=${contract.address.toString()}`)
  console.log(`AZTEC_START_BLOCK=${startBlock}`)
} finally {
  await session.stop()
}
