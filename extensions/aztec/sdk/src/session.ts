// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { AztecAddress } from '@aztec-labs/aztec.js/addresses'
import { getContractInstanceFromInstantiationParams } from '@aztec-labs/aztec.js/contracts'
import { SponsoredFeePaymentMethod } from '@aztec-labs/aztec.js/fee'
import { createAztecNodeClient } from '@aztec-labs/aztec.js/node'
import { SPONSORED_FPC_SALT } from '@aztec-labs/constants'
import { Fq, Fr } from '@aztec-labs/foundation/curves/bn254'
import { SponsoredFPCContract } from '@aztec-labs/noir-contracts.js/SponsoredFPC'
import type { AztecNode } from '@aztec-labs/stdlib/interfaces/client'
import { EmbeddedWallet } from '@aztec-labs/wallets/embedded'

/**
 * A connection to an Aztec network: a node, a wallet holding one account, and the sponsor that pays its fees.
 *
 * The account is an initializerless Schnorr account created from random keys. It needs no deployment
 * transaction, nothing links two sessions, and nothing is stored once the process exits: a voter's account is
 * disposable by design, and a keeper's holds no funds. The fee is paid by the network's canonical SponsoredFPC,
 * which sponsors every transaction.
 */
export type AztecSession = {
  node: AztecNode
  wallet: EmbeddedWallet
  /** The account every transaction is sent from. A ZKPassport proof is bound to this address. */
  address: AztecAddress
  fee: { paymentMethod: SponsoredFeePaymentMethod }
  /** The rollup version L1 messages are addressed to. */
  rollupVersion: number
  /** The L1 chain the rollup settles on. */
  l1ChainId: number
  stop: () => Promise<void>
}

/** The canonical SponsoredFPC instance: deployed by the local network and by public networks with a zero salt. */
const sponsoredFpc = () => getContractInstanceFromInstantiationParams(SponsoredFPCContract.artifact, { salt: new Fr(SPONSORED_FPC_SALT) })

export type ConnectOptions = {
  /**
   * Prove transactions client-side (default). The embedded wallet does not prove unless told to, and a transaction it did
   * not prove is not checked at all by its own simulation: the ACVM does not run the `verify_honk_proof` recursion that the
   * ZKPassport and ballot checks rest on. A public network rejects such a transaction; a local network accepts it, so turning
   * this off there trades the check for speed.
   */
  prove?: boolean
}

export const connectAztec = async (nodeUrl: string, options: ConnectOptions = {}): Promise<AztecSession> => {
  const node = createAztecNodeClient(nodeUrl)
  const wallet = await EmbeddedWallet.create(node, { ephemeral: true, pxe: { proverEnabled: options.prove ?? true } })
  try {
    const account = await wallet.createSchnorrInitializerlessAccount(Fr.random(), Fr.random(), Fq.random())
    const fpc = await sponsoredFpc()
    await wallet.registerContract(fpc, SponsoredFPCContract.artifact)

    return {
      node,
      wallet,
      address: account.address,
      fee: { paymentMethod: new SponsoredFeePaymentMethod(fpc.address) },
      rollupVersion: await node.getVersion(),
      l1ChainId: await node.getChainId(),
      stop: () => wallet.stop(),
    }
  } catch (error) {
    await wallet.stop()
    throw error
  }
}
