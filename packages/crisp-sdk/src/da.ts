// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { hexToBytes, keccak256 } from 'viem'

import type { Address, Hex } from 'viem'

/**
 * Largest object the data-availability layer accepts, mirroring `MAX_OBJECT_BYTES` in the Interfold
 * `e3-data-availability` crate. A longer answer cannot be a ciphertext anyone published.
 */
export const MAX_DA_OBJECT_BYTES = 1024 * 1024

/**
 * One ciphertext to read back, as `CRISPProgram` records it.
 *
 * `InputCommitted` fixes everything but the availability coordinates. `InputPublished` carries
 * those once the data-availability receipt is verified on chain, so an entry still waiting for its
 * receipt has `availabilityBlock` and `availabilityLeafIndex` undefined: its bytes can only come
 * from a reader that holds them by content hash.
 */
export type DaEntry = {
  e3Id: bigint
  /** The slot the entry was written to. */
  slot: Address
  /** The entry's tree index. */
  index: number
  /** `keccak256` of the serialized ciphertext, as committed on chain. */
  encryptedVoteHash: Hex
  /** The data-availability block that holds the bytes, from `InputPublished`. */
  availabilityBlock?: number
  /** The leaf position inside that block's data root, from `InputPublished`. */
  availabilityLeafIndex?: bigint
}

/**
 * Where a ciphertext's bytes come from.
 *
 * Implementations only fetch; they need not check the content. {@link readVerified} compares
 * `keccak256(bytes)` with `encryptedVoteHash` before anything uses them, so a reader that returns
 * the wrong bytes is refused rather than trusted.
 */
export interface DaReader {
  read(entry: DaEntry): Promise<Uint8Array>
}

/**
 * Read an entry's bytes and check them against the hash `CRISPProgram` committed.
 *
 * The contract commits `encryptedVoteHash = keccak256(ciphertext)` and binds it into the input
 * leaf, so bytes that hash differently are not the entry's ciphertext — whatever the reader says.
 *
 * @throws If the reader fails, the bytes exceed {@link MAX_DA_OBJECT_BYTES}, or their hash differs
 */
export const readVerified = async (reader: DaReader, entry: DaEntry): Promise<Uint8Array> => {
  const bytes = await reader.read(entry)

  if (bytes.length === 0 || bytes.length > MAX_DA_OBJECT_BYTES) {
    throw new Error(`Data-availability object for entry ${entry.index} is ${bytes.length} bytes`)
  }

  const actual = keccak256(bytes)
  if (actual !== entry.encryptedVoteHash.toLowerCase()) {
    throw new Error(`Data-availability bytes for entry ${entry.index} hash to ${actual}, expected ${entry.encryptedVoteHash}`)
  }

  return bytes
}

/**
 * Reader that asks several readers in turn and returns the first answer whose hash is right.
 *
 * An entry that has no Avail receipt yet can only come from a store that holds the bytes by content
 * hash, while one that has is best read from Avail itself, so a client usually wants both:
 * `createFallbackDaReader(createAvailDaReader(...), createHttpDaReader(...))`. A reader that
 * fails, or answers with bytes that hash differently, is skipped rather than trusted.
 *
 * @throws If no reader supplies the bytes, naming what each one said
 */
export const createFallbackDaReader = (...readers: DaReader[]): DaReader => ({
  async read(entry) {
    const failures: string[] = []

    for (const reader of readers) {
      try {
        return await readVerified(reader, entry)
      } catch (error) {
        failures.push(error instanceof Error ? error.message : String(error))
      }
    }

    throw new Error(`No reader supplied entry ${entry.index}: ${failures.join('; ') || 'no readers configured'}`)
  },
})

type FetchLike = typeof fetch

/**
 * Options shared by the HTTP readers.
 */
export type HttpDaReaderOptions = {
  /** Fetch implementation. Defaults to the global `fetch`. */
  fetch?: FetchLike
}

/**
 * Reader for an HTTP object store keyed by content hash: `GET {baseUrl}/objects/{hash}` answers
 * with the raw bytes. This is the layout of the Interfold mock data-availability service and, with
 * `baseUrl = '<crisp server>/availability'`, of the CRISP server's staging route — which also
 * holds entries that have no Avail receipt yet.
 *
 * @param baseUrl - The store's base URL, without the `/objects` segment
 */
export const createHttpDaReader = (baseUrl: string, { fetch: fetchImpl = fetch }: HttpDaReaderOptions = {}): DaReader => {
  const base = baseUrl.replace(/\/+$/, '')

  return {
    async read(entry) {
      const response = await fetchImpl(`${base}/objects/${entry.encryptedVoteHash}`)

      if (!response.ok) {
        throw new Error(`Object ${entry.encryptedVoteHash} is unavailable at ${base}: ${response.status} ${response.statusText}`)
      }

      return new Uint8Array(await response.arrayBuffer())
    },
  }
}

/**
 * The tail of an extrinsic that is a SCALE `Vec<u8>` ending exactly at the extrinsic's end and
 * hashing to `contentHash`.
 *
 * Avail's `DataAvailability.submit_data(data)` call is the last field of its extrinsic, so the
 * bytes sit behind a compact length that ends at the extrinsic's end. Rather than decode the
 * signature, era and extensions that precede the call — which differ between runtime versions —
 * every offset whose compact length lines up with the end is tried, and the keccak hash decides.
 */
const dataTail = (extrinsic: Uint8Array, contentHash: Hex): Uint8Array | undefined => {
  const end = extrinsic.length

  for (let at = 0; at < end; at++) {
    const first = extrinsic[at]
    let width: number
    let length: number

    switch (first & 0b11) {
      case 0:
        width = 1
        length = first >> 2
        break
      case 1:
        if (at + 1 >= end) continue
        width = 2
        length = (first | (extrinsic[at + 1] << 8)) >> 2
        break
      case 2:
        if (at + 3 >= end) continue
        width = 4
        length = (first | (extrinsic[at + 1] << 8) | (extrinsic[at + 2] << 16) | (extrinsic[at + 3] << 24)) >>> 2
        break
      default:
        // Big-integer mode: no object this size is ever published.
        continue
    }

    if (at + width + length !== end) continue

    const data = extrinsic.subarray(at + width)
    if (keccak256(data) === contentHash) return data
  }

  return undefined
}

/**
 * Options for {@link createAvailDaReader}.
 */
export type AvailDaReaderOptions = HttpDaReaderOptions & {
  /**
   * HTTP(S) JSON-RPC endpoint of an Avail node, for example `https://turing-rpc.avail.so/rpc` for
   * the Turing testnet that Sepolia rounds publish to. WebSocket endpoints are not accepted.
   */
  rpcUrl: string
}

/**
 * Reader that fetches ciphertexts straight from Avail, with no CRISP server involved.
 *
 * `InputPublished.availabilityBlock` names the Avail block holding the `submit_data` extrinsic.
 * The reader asks the node for that block over plain JSON-RPC (`chain_getBlockHash`,
 * `chain_getBlock`) and returns the extrinsic payload whose `keccak256` equals the entry's
 * `encryptedVoteHash` — the same search the Interfold `AvailReader` makes, without its Rust client.
 * Nothing here needs a WebSocket or a heavyweight dependency, so it runs in a browser if the node
 * allows cross-origin requests (Turing does).
 *
 * Cannot serve an entry that has no `availabilityBlock` yet.
 */
export const createAvailDaReader = ({ rpcUrl, fetch: fetchImpl = fetch }: AvailDaReaderOptions): DaReader => {
  if (!/^https?:\/\//i.test(rpcUrl)) {
    throw new Error('Avail RPC URL must use HTTP or HTTPS')
  }

  let nextId = 0
  const call = async <T>(method: string, params: unknown[]): Promise<T> => {
    const response = await fetchImpl(rpcUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++nextId, method, params }),
    })

    if (!response.ok) {
      throw new Error(`Avail ${method} failed: ${response.status} ${response.statusText}`)
    }

    const body = (await response.json()) as { result?: T; error?: { message?: string } }
    if (body.error) {
      throw new Error(`Avail ${method} failed: ${body.error.message ?? 'unknown error'}`)
    }

    return body.result as T
  }

  return {
    async read(entry) {
      if (entry.availabilityBlock === undefined) {
        throw new Error(`Entry ${entry.index} has no Avail receipt yet, so its Avail block is unknown`)
      }

      const blockHash = await call<string | null>('chain_getBlockHash', [entry.availabilityBlock])
      if (!blockHash) {
        throw new Error(`Avail has no block ${entry.availabilityBlock}`)
      }

      const block = await call<{ block: { extrinsics: string[] } } | null>('chain_getBlock', [blockHash])
      if (!block) {
        throw new Error(`Avail returned no body for block ${entry.availabilityBlock}`)
      }

      const contentHash = entry.encryptedVoteHash.toLowerCase() as Hex
      for (const extrinsic of block.block.extrinsics) {
        const data = dataTail(hexToBytes(extrinsic as Hex), contentHash)
        if (data) return data.slice()
      }

      throw new Error(`Avail block ${entry.availabilityBlock} does not contain object ${contentHash}`)
    },
  }
}
