// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { getInitialTestAccountsData } from '@aztec-labs/accounts/testing'
import { AztecAddress } from '@aztec-labs/aztec.js/addresses'
import { Contract, getContractInstanceFromInstantiationParams, type ContractFunctionInteraction } from '@aztec-labs/aztec.js/contracts'
import { SponsoredFeePaymentMethod } from '@aztec-labs/aztec.js/fee'
import { createAztecNodeClient } from '@aztec-labs/aztec.js/node'
import { SPONSORED_FPC_SALT } from '@aztec-labs/constants'
import { Fr } from '@aztec-labs/foundation/curves/bn254'
import { SponsoredFPCContract } from '@aztec-labs/noir-contracts.js/SponsoredFPC'
import { deriveStorageSlotInMap } from '@aztec-labs/stdlib/hash'
import { createAztecNodeDebugClient, type AztecNode, type AztecNodeDebug } from '@aztec-labs/stdlib/interfaces/client'
import { EmbeddedWallet } from '@aztec-labs/wallets/embedded'
import { ZKPassportRegistryArtifact } from '@zkpassport/aztec'

import { CIRCUITS_VERSION, mockRegistryRoots, packCircuitVersion, scopeHash } from './proof'

/**
 * Where the vendored `ZKPassportRegistry` lives on a local network (`local_network_registry.nr`): the address ZKPassport's
 * verifier library finds on chain id 31337, and the one `CrispAztec` is configured with. It is a function of the registry's
 * bytecode, its constructor arguments (the local network's test accounts 0 and 1) and a fixed salt.
 */
export const LOCAL_NETWORK_REGISTRY_ADDRESS = AztecAddress.fromStringUnsafe('0x150417513440e16bf6caa69b608dc2ec4e17cb038cd00f7714b521fe5240866d')

/** `MODE_VALID_WITHIN_WINDOW` and the window the local network registry is deployed with. */
const REGISTRY_MODE = 3
const REGISTRY_WINDOW = 86_400n
/** The registry applies every change this many seconds after it is made (`INITIAL_DELAY`). */
export const REGISTRY_DELAY_SECONDS = 86_400n
const REGISTRY_CERTIFICATE = 1n
const REGISTRY_CIRCUIT = 2n

export type RegistryContext = {
  nodeUrl: string
  node: AztecNode
  wallet: EmbeddedWallet
  /** The registry's admin: the local network's test account 0. */
  admin: AztecAddress
  /** The registry's operator: the local network's test account 1. */
  operator: AztecAddress
  fee: { paymentMethod: SponsoredFeePaymentMethod }
  stop: () => Promise<void>
}

/** A wallet that holds the local network's test accounts 0 and 1, the registry's admin and operator. */
export const connectRegistryContext = async (nodeUrl: string): Promise<RegistryContext> => {
  const node = createAztecNodeClient(nodeUrl)
  const wallet = await EmbeddedWallet.create(node, { ephemeral: true })
  try {
    const [admin, operator] = await getInitialTestAccountsData()
    if (!admin || !operator) throw new Error('The network has no test accounts: the registry is administered by test accounts 0 and 1')
    for (const account of [admin, operator]) await wallet.createSchnorrInitializerlessAccount(account.secret, account.salt, account.signingKey)

    const fpc = await getContractInstanceFromInstantiationParams(SponsoredFPCContract.artifact, { salt: new Fr(SPONSORED_FPC_SALT) })
    await wallet.registerContract(fpc, SponsoredFPCContract.artifact)

    return {
      nodeUrl,
      node,
      wallet,
      admin: admin.address,
      operator: operator.address,
      fee: { paymentMethod: new SponsoredFeePaymentMethod(fpc.address) },
      stop: () => wallet.stop(),
    }
  } catch (error) {
    await wallet.stop()
    throw error
  }
}

/** Timestamp of the latest L2 block: the clock private functions (and so the registry's delay and a proof's freshness) read. */
export const chainTime = async (node: AztecNode): Promise<number> => {
  const block = await node.getBlock('latest')
  if (!block) throw new Error('The node has no blocks yet')

  return Number(block.header.globalVariables.timestamp)
}

/**
 * Advance the local network's clock (L1 and L2 together) to at least `timestamp` and build an empty L2 block there. Needs
 * the node's debug API, which a local network serves. Time only moves forward and every service sharing the network sees it.
 */
export const warpTo = async (nodeUrl: string, timestamp: number): Promise<void> => {
  const debug: AztecNodeDebug = createAztecNodeDebugClient(nodeUrl)
  await debug.warpL2TimeAtLeastTo(timestamp)
}

/** `ServiceConfig.version` for a circuits release: what the registry keys its accepted verification keys by. */
export const circuitsVersionField = (semver: string = CIRCUITS_VERSION): bigint => packCircuitVersion(semver)

/** `zkpassport_domain` for a domain name: the hash the SDK puts in the proof's `domain` public input. */
export const domainHash = (domain: string): bigint => scopeHash(domain)

const registryContract = (context: RegistryContext, address: AztecAddress) => Contract.at(address, ZKPassportRegistryArtifact, context.wallet)

/** Deploy the registry at `LOCAL_NETWORK_REGISTRY_ADDRESS` (universally, from test account 0) unless it is already there. */
export const deployLocalRegistry = async (context: RegistryContext): Promise<AztecAddress> => {
  const existing = await context.node.getContract(LOCAL_NETWORK_REGISTRY_ADDRESS)
  if (existing) {
    await context.wallet.registerContract(existing, ZKPassportRegistryArtifact)

    return LOCAL_NETWORK_REGISTRY_ADDRESS
  }

  const salt = scopeHash('ZKPASSPORT::AZTEC::LOCAL_NETWORK_REGISTRY')
  const { contract } = await Contract.deploy(
    context.wallet,
    ZKPassportRegistryArtifact,
    [context.admin, context.operator, REGISTRY_MODE, REGISTRY_WINDOW],
    'constructor',
    { salt: new Fr(salt), universalDeploy: true },
  ).send({ from: context.admin, fee: context.fee })
  if (!contract.address.equals(LOCAL_NETWORK_REGISTRY_ADDRESS)) {
    throw new Error(`The registry deployed at ${contract.address}, not at ${LOCAL_NETWORK_REGISTRY_ADDRESS}: the artifact or the toolchain changed`)
  }

  return contract.address
}

const unwrap = <T>(simulation: unknown): T => {
  if (typeof simulation === 'object' && simulation !== null && 'result' in simulation) return simulation.result as T

  return simulation as T
}

/**
 * A `DelayedPublicMutable` write that is still waiting out its delay, read from public storage: the utility views only show
 * values already applied. Layout (the protocol's `DelayedPublicMutableValues`, `2M+1` slots for an `M`-field value): the
 * first slot packs both change timestamps (the value's in the low 32 bits), then the old value, then the new one.
 */
const scheduledChange = async (context: RegistryContext, variable: string, keys: bigint[], size: number): Promise<{ post: Fr[]; maturesAt: number }> => {
  const layout = ZKPassportRegistryArtifact.storageLayout[variable]
  if (!layout) throw new Error(`The registry has no storage variable ${variable}`)
  let slot = layout.slot
  for (const key of keys) slot = await deriveStorageSlotInMap(slot, { toField: () => new Fr(key) })
  const fields = await Promise.all(
    Array.from({ length: 2 * size + 1 }, (_, i) => context.node.getPublicStorageAt('latest', LOCAL_NETWORK_REGISTRY_ADDRESS, slot.add(new Fr(i)))),
  )

  return { post: fields.slice(1 + size), maturesAt: Number(fields[0]!.toBigInt() & 0xffffffffn) }
}

export type SeedRegistryOptions = {
  /** Roots a proof commits to (`MockRegistrationProof.certificateRoot` / `circuitRoot`). Default: those of the mock proofs. */
  certificateRoot?: string
  circuitRoot?: string
  /** Outer circuit verification key hashes to accept (`MockRegistrationProof.vkeyHash`). Default: `outer_count_4`, `outer_count_5` and `outer_count_6`. */
  vkeyHashes?: string[]
  /** Circuits release the keys belong to; default the one the proofs are generated for. */
  circuitsVersion?: string
  /** Wait (by warping the network clock) until everything seeded is readable by private functions. Default true. */
  warp?: boolean
}

export type SeedRegistryResult = {
  /** Transactions sent; empty when the registry was already seeded. */
  transactions: { name: string; txHash: string }[]
  /** Chain time at which the last change becomes readable by private functions. */
  readyAt: number
}

/**
 * Seed the registry at `LOCAL_NETWORK_REGISTRY_ADDRESS` with a certificate root, a circuit root and outer vk hashes, as the
 * operator and admin, skipping whatever is already live or scheduled. The registry applies every change 24 hours (chain time)
 * after it is made, so unless `warp` is false this warps the network clock past that. Warp BEFORE opening rounds and sending
 * other time-dependent transactions: the clock moves for everything on the network.
 */
export const seedLocalRegistry = async (context: RegistryContext, options: SeedRegistryOptions = {}): Promise<SeedRegistryResult> => {
  const mock = await mockRegistryRoots()
  const certificateRoot = options.certificateRoot ?? mock.certificateRoot
  const circuitRoot = options.circuitRoot ?? mock.circuitRoot
  const vkeyHashes = options.vkeyHashes ?? [mock.vkeyHashes.outer_count_4, mock.vkeyHashes.outer_count_5, mock.vkeyHashes.outer_count_6]
  await deployLocalRegistry(context)
  const registry = await registryContract(context, LOCAL_NETWORK_REGISTRY_ADDRESS)
  const version = packCircuitVersion(options.circuitsVersion ?? CIRCUITS_VERSION)
  const transactions: SeedRegistryResult['transactions'] = []
  const send = async (name: string, from: AztecAddress, call: ContractFunctionInteraction) => {
    const { receipt } = await call.send({ from, fee: context.fee })
    transactions.push({ name, txHash: receipt.txHash.toString() })
  }
  const now = await chainTime(context.node)

  for (const [id, label, root] of [
    [REGISTRY_CERTIFICATE, 'certificate', certificateRoot],
    [REGISTRY_CIRCUIT, 'circuit', circuitRoot],
  ] as const) {
    const target = BigInt(root)
    const live = unwrap<{ latest: bigint }>(await registry.methods.get_latest_pair(id).simulate({ from: context.operator })).latest
    const { post, maturesAt } = await scheduledChange(context, 'latest', [id], 2)
    const pending = maturesAt > now
    if (live === target || (pending && post[0]!.toBigInt() === target)) continue
    const current = pending ? post[0]!.toBigInt() : live
    await send(`update_root(${label})`, context.operator, registry.methods.update_root(id, target, current, BigInt(now)))
  }

  for (const hash of vkeyHashes) {
    const vk = BigInt(hash)
    const accepted = unwrap<boolean>(await registry.methods.is_vk_accepted(version, vk).simulate({ from: context.admin }))
    const { post, maturesAt } = await scheduledChange(context, 'accepted_vks', [version, vk], 1)
    if (accepted || (maturesAt > now && !post[0]!.isZero())) continue
    await send(`add_accepted_vk(${hash.slice(0, 12)}…)`, context.admin, registry.methods.add_accepted_vk(version, vk))
  }

  const enabled = unwrap<boolean>(await registry.methods.is_version_enabled(version).simulate({ from: context.admin }))
  const enabling = await scheduledChange(context, 'version_enabled', [version], 1)
  if (!enabled && !(enabling.maturesAt > now && !enabling.post[0]!.isZero())) {
    await send('set_version_status(true)', context.admin, registry.methods.set_version_status(version, true))
  }

  // Everything is now live or scheduled: the latest maturity among the changes is when private functions can rely on it.
  const maturities = [
    (await scheduledChange(context, 'latest', [REGISTRY_CERTIFICATE], 2)).maturesAt,
    (await scheduledChange(context, 'latest', [REGISTRY_CIRCUIT], 2)).maturesAt,
    enabling.maturesAt,
    ...(await Promise.all(vkeyHashes.map(async (hash) => (await scheduledChange(context, 'accepted_vks', [version, BigInt(hash)], 1)).maturesAt))),
  ]
  const readyAt = Math.max(now, ...maturities)
  if (options.warp !== false && (await chainTime(context.node)) < readyAt) {
    await warpTo(context.nodeUrl, readyAt + 1)
  }

  return { transactions, readyAt }
}
