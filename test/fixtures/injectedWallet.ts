// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { test as base, type BrowserContext } from '@playwright/test'
import { createPublicClient, createWalletClient, http, type Hex } from 'viem'
import { mnemonicToAccount } from 'viem/accounts'
import { anvil } from 'viem/chains'

// The well-known anvil/hardhat development mnemonic. Index 0 is
// 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266, which the local stack funds.
const MNEMONIC = 'test test test test test test test test test test test junk'
const RPC_URL = 'http://127.0.0.1:8545'
const CHAIN_ID_HEX = `0x${anvil.id.toString(16)}`

type WalletEvent = [event: string, payload: unknown]
type BridgeError = { code: number; message: string; data?: unknown }
type BridgeResponse = { ok: unknown; events: WalletEvent[] } | { err: BridgeError }

class WalletError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message)
  }
}

/**
 * An EIP-1193 wallet for one browser context.
 *
 * The key stays in Node: the page only holds a provider whose `request` calls are relayed here, so
 * signatures are real and no extension (or approval popup) is involved. Account access follows
 * MetaMask's permission model — `eth_accounts` is empty until `eth_requestAccounts` succeeds, and
 * the grant survives page reloads for the lifetime of the context.
 */
function createWallet() {
  const account = mnemonicToAccount(MNEMONIC)
  const transport = http(RPC_URL)
  const publicClient = createPublicClient({ chain: anvil, transport })
  const walletClient = createWalletClient({ account, chain: anvil, transport })
  let connected = false

  const assertOwnAddress = (address: unknown) => {
    if (typeof address !== 'string' || address.toLowerCase() !== account.address.toLowerCase()) {
      throw new WalletError(4100, `The requested account ${String(address)} is not authorized`)
    }
  }

  async function handle(method: string, params: unknown[]): Promise<{ result: unknown; events: WalletEvent[] }> {
    const events: WalletEvent[] = []
    switch (method) {
      case 'eth_requestAccounts': {
        if (!connected) {
          connected = true
          events.push(['connect', { chainId: CHAIN_ID_HEX }], ['accountsChanged', [account.address]])
        }
        return { result: [account.address], events }
      }
      case 'eth_accounts':
        return { result: connected ? [account.address] : [], events }
      case 'eth_chainId':
        return { result: CHAIN_ID_HEX, events }
      case 'net_version':
        return { result: String(anvil.id), events }
      case 'wallet_switchEthereumChain': {
        const [{ chainId }] = params as [{ chainId: string }]
        if (chainId.toLowerCase() !== CHAIN_ID_HEX) {
          throw new WalletError(4902, `Unrecognized chain ID ${chainId}`)
        }
        return { result: null, events }
      }
      case 'wallet_addEthereumChain':
        return { result: null, events }
      case 'wallet_getPermissions':
        return { result: connected ? [{ parentCapability: 'eth_accounts' }] : [], events }
      case 'wallet_requestPermissions': {
        const requested = await handle('eth_requestAccounts', [])
        return { result: [{ parentCapability: 'eth_accounts' }], events: requested.events }
      }
      case 'wallet_revokePermissions': {
        if (connected) {
          connected = false
          events.push(['accountsChanged', []])
        }
        return { result: null, events }
      }
      case 'personal_sign': {
        const [message, address] = params as [Hex, string]
        assertOwnAddress(address)
        return { result: await account.signMessage({ message: { raw: message } }), events }
      }
      case 'eth_signTypedData_v4': {
        const [address, typedData] = params as [string, string | Record<string, unknown>]
        assertOwnAddress(address)
        const { domain, types, primaryType, message } = (typeof typedData === 'string' ? JSON.parse(typedData) : typedData) as {
          domain: Record<string, unknown>
          types: Record<string, { name: string; type: string }[]>
          primaryType: string
          message: Record<string, unknown>
        }
        // viem derives EIP712Domain from `domain`; passing it in `types` is rejected.
        const { EIP712Domain: _domain, ...structs } = types
        return { result: await account.signTypedData({ domain, types: structs, primaryType, message }), events }
      }
      case 'eth_sendTransaction': {
        const [tx] = params as [{ to?: Hex; data?: Hex; value?: Hex; gas?: Hex }]
        const hash = await walletClient.sendTransaction({
          to: tx.to,
          data: tx.data,
          value: tx.value ? BigInt(tx.value) : undefined,
          gas: tx.gas ? BigInt(tx.gas) : undefined,
        })
        return { result: hash, events }
      }
      default:
        return { result: await publicClient.request({ method, params } as never), events }
    }
  }

  return {
    address: account.address,
    async request(method: string, params: unknown[] = []): Promise<BridgeResponse> {
      try {
        const { result, events } = await handle(method, params)
        return { ok: result, events }
      } catch (error) {
        const e = error as { code?: unknown; shortMessage?: string; message?: string; data?: unknown }
        return {
          err: {
            code: typeof e.code === 'number' ? e.code : -32603,
            message: e.shortMessage ?? e.message ?? String(error),
            data: e.data,
          },
        }
      }
    },
  }
}

/**
 * Installs the wallet on every page of `context`: relays requests to Node and, before any page
 * script runs, defines `window.ethereum` and announces it over EIP-6963 as MetaMask so that
 * ConnectKit lists it under its "MetaMask" button.
 */
async function installInjectedWallet(context: BrowserContext): Promise<void> {
  const wallet = createWallet()

  await context.exposeFunction('__injectedWalletRequest', (method: string, params?: unknown[]) => wallet.request(method, params))

  await context.addInitScript(() => {
    type Listener = (payload: unknown) => void
    const w = window as unknown as {
      ethereum?: unknown
      __injectedWalletRequest: (method: string, params?: unknown[]) => Promise<BridgeResponse>
    }
    const listeners: Record<string, Listener[]> = {}

    const emit = (event: string, payload: unknown) => {
      for (const listener of [...(listeners[event] ?? [])]) listener(payload)
    }

    const provider = {
      isMetaMask: true,
      isConnected: () => true,
      request: async ({ method, params }: { method: string; params?: unknown[] }) => {
        const response = await w.__injectedWalletRequest(method, params)
        if ('err' in response) {
          throw Object.assign(new Error(response.err.message), { code: response.err.code, data: response.err.data })
        }
        // Delivered after the request resolves, like a real wallet, which answers the dapp first.
        for (const [event, payload] of response.events) setTimeout(() => emit(event, payload), 0)
        return response.ok
      },
      on(event: string, listener: Listener) {
        ;(listeners[event] ??= []).push(listener)
        return provider
      },
      removeListener(event: string, listener: Listener) {
        listeners[event] = (listeners[event] ?? []).filter((l) => l !== listener)
        return provider
      },
    }
    ;(provider as Record<string, unknown>).addListener = provider.on
    ;(provider as Record<string, unknown>).off = provider.removeListener

    w.ethereum = provider

    const info = {
      uuid: '0b1f6a7e-0000-4000-8000-0000000000e2',
      name: 'MetaMask',
      icon: 'data:image/svg+xml,<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
      rdns: 'io.metamask',
    }
    const announce = () => window.dispatchEvent(new CustomEvent('eip6963:announceProvider', { detail: Object.freeze({ info, provider }) }))
    window.addEventListener('eip6963:requestProvider', announce)
    announce()
  })
}

/** Playwright `test` whose browser context carries the injected, auto-signing anvil wallet. */
export const test = base.extend({
  context: async ({ context }, provide) => {
    await installInjectedWallet(context)
    await provide(context)
  },
})

export const { expect } = test
