// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import type { Address } from 'viem'

export const CHAIN_ID = { SEPOLIA: 11155111, CHIADO: 10200 } as const

/** Sepolia: where Interfold, the committee and `CRISPGnosisProgram` live. */
export const SEPOLIA = {
  interfold: '0xb35EE9ed8BE5967daabBA8c2e817C52D0b57ac26',
  ciphernodeRegistry: '0xb1E8640CF8D0A927290E3d9E1b01c4899B5225Ef',
  /** The Foreign side of the Gnosis AMB: `executeSignatures` delivers ROOT here. */
  foreignAmb: '0xf2546D6648BD2af6a008A7e7C1542BB240329E11',
  feeToken: '0xE2e534F7Cb95777eD870CDCaCb80B1E9E2aD555B',
} as const satisfies Record<string, Address>

/** Chiado: where the ballots, the token and the Safe live. */
export const CHIADO = {
  homeAmb: '0x8448E15d0e706C0298dECA99F0b4744030e59d7d',
  /** Packs the validators' signatures of a Home→Foreign message (`getSignatures`). */
  ambHelper: '0x3cc500B3c01D04C265c9293cB35BA2Fd8eA6dc1b',
  safeSingleton: '0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552',
  safeL2Singleton: '0x3E5c63644E683549055b9Be8653de26E0B4CD36E',
  safeProxyFactory: '0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2',
  multiSend: '0xA238CBeb142c10Ef7Ad8442C6D1f9E89e07e7761',
  /** The batch executor: `MultiSendCallOnly` refuses delegate calls inside the batch. */
  multiSendCallOnly: '0x40A2aCCbd92BCA938b02010E17A5b8929b49130D',
  fallbackHandler: '0xf48f2B2d2a534e402487b3ee7C18c33Aec0Fe5e4',
  moduleProxyFactory: '0x000000000000aDdB49795b0f9bA5BC298cDda236',
} as const satisfies Record<string, Address>

/** First word of every AMB message (`CRISPRemoteMessages` for 1-3, `CRISPGnosisMessages` for 4). */
export const MESSAGE_KIND = { ROUND: 1n, KEY: 2n, ROOT: 3n, RESULT: 4n } as const

/** The options of every proposal, as the index a ballot carries. */
export const OPTION = { FOR: 0, AGAINST: 1, ABSTAIN: 2 } as const
export const NUM_OPTIONS = 3

/** `IInterfold.E3Stage`. */
export const E3_STAGE = {
  None: 0,
  Requested: 1,
  CommitteeFinalized: 2,
  KeyPublished: 3,
  CiphertextReady: 4,
  Complete: 5,
  Failed: 6,
} as const

/** The EIP-712 domain name and version of `CrispGnosisVoting`. */
export const EIP712_NAME = 'CRISP'
export const EIP712_VERSION = '1'
