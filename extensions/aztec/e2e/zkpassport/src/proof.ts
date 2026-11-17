// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { sha256, stringToBytes } from 'viem'

const run = promisify(execFile)
const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..')
const circuitsDir = join(root, '.cache', 'circuits')

/** The ZKPassport circuits release the generated proofs belong to (zkpassport/circuits `noir-v1.0.0`, built for bb 6.0.0). */
export const CIRCUITS_VERSION = '0.22.0'

/** Aztec's `sha256_to_field` and ZKPassport's `getServiceScopeHash`: SHA-256 with the last byte dropped. */
export const scopeHash = (value: string): bigint => BigInt(sha256(stringToBytes(value))) >> 8n

/** The circuits release as the registry and `ServiceConfig.version` key it: three 2-byte big-endian numbers, left-aligned in a bytes32. */
export const packCircuitVersion = (semver: string): bigint => {
  const parts = semver.split('.').map(Number)
  if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 0xffff)) throw new Error(`Invalid circuits version: ${semver}`)
  const [major, minor, patch] = parts as [number, number, number]

  return (BigInt(major) << 240n) | (BigInt(minor) << 224n) | (BigInt(patch) << 208n)
}

export type MockRegistrationProofOptions = {
  /** The Aztec account that will send the `register` transaction: the proof is bound to it (`bind_user_address`). */
  aztecAddress: string
  /** The contract's `zkpassport_domain` hash (the `domain` public input). */
  domain: bigint
  /** The round's scope string (`CRISPAztecProgram.scopeOf(e3Id)`); its hash is the `scope` public input. */
  scope: string
  /** Minimum age to prove (`register_with_age`, outer_count_5). Leave 0 to prove only the binding (`register`, outer_count_4). */
  minAge?: number
  /**
   * A nationality rule to prove (adds a subproof): `mode` 1 = nationality in `countries`, 2 = not in them; alpha-3 codes, the order
   * the round's commitment was made with. The mock document's nationality is `ZKR`. Omit for none.
   */
  nationality?: { mode: 1 | 2; countries: string[] }
  /** `current_date` of the proof, Unix seconds. The contract accepts it between `anchor - validity` and `anchor + 1h`. */
  now: number | bigint
  /**
   * The document number (up to 9 characters of A-Z, 0-9, `<`; padded with `<` as in a passport's MRZ). A document is identified
   * by it: a second voter needs another number, because the contract allows one registration per document and round.
   */
  documentNumber?: string
  /** Date of birth, YYMMDD. Default 1988-11-12. */
  birthDate?: string
}

/** A proof as the ZKPassport SDK's `compressed` mode returns it, with what seeding the registry and debugging need. */
export type MockRegistrationProof = {
  /** `outer_count_4` (bind), `outer_count_5` (age or nationality, and bind) or `outer_count_6` (age, nationality and bind). */
  circuit: 'outer_count_4' | 'outer_count_5' | 'outer_count_6'
  /** The subproof count the `CrispAztec.register*` entry point expects: 4, 5 or 6. */
  subproofs: 4 | 5 | 6
  /** `ProofResult.proof`: public inputs then proof, one 32-byte field each, as bare hex. Feed it to `CrispAztec.register({ proof })`. */
  proof: string
  /** `ProofResult.vkeyHash`: the outer circuit's verification key hash, which the registry has to accept. */
  vkeyHash: string
  /** The outer circuit's verification key (115 fields); the SDK would fetch it by `vkeyHash`, here it comes with the proof. */
  vkeyFields: string[]
  proofFields: string[]
  publicInputs: string[]
  /** The registry roots the proof commits to: seed them with `seedLocalRegistry`. */
  certificateRoot: string
  circuitRoot: string
  circuitsVersion: string
  now: number
  /** `NON_SALTED_MOCK` (2): the document is of the mock country, so the round must allow mock documents. */
  nullifierType: number
  scopedNullifier: string
}

type ProverResult = {
  circuit: 'outer_count_4' | 'outer_count_5' | 'outer_count_6'
  circuitVersion: string
  now: number
  certificateRegistryRoot: string
  circuitRegistryRoot: string
  vkeyHash: string
  nullifierType: number
  scopedNullifier: string
  vkeyFields: string[]
  proofFields: string[]
  publicInputs: string[]
}

const bare = (field: string) => field.replace(/^0x/, '').padStart(64, '0')

/** Fetch the circuits checkout and its dependencies (once), unless they are already there. */
export const setupCircuits = async (): Promise<void> => {
  await run('node', [join(root, 'scripts', 'setup-circuits.mjs')], { maxBuffer: 64 * 1024 * 1024 })
}

/** A directory holding the `bb` 6.0.0 that Aztec 6.0.0 ships; the circuits are proved with it, since only its transcript is accepted. */
const bbDirectory = (): string | undefined => {
  const candidates = [process.env.BB_DIR, join(process.env.AZTEC_HOME ?? join(homedir(), '.aztec'), 'versions', '6.0.0', 'node_modules', '.bin')]

  return candidates.find((dir): dir is string => dir !== undefined && existsSync(join(dir, 'bb')))
}

/** Run `prove-mock.cts` inside the circuits checkout, with bb 6.0.0 first on the PATH, and return its JSON result. */
const runProver = async <T>(request: object): Promise<T> => {
  if (!existsSync(join(circuitsDir, 'node_modules'))) await setupCircuits()

  const dir = mkdtempSync(join(tmpdir(), 'crisp-zkpassport-'))
  try {
    const requestFile = join(dir, 'request.json')
    const resultFile = join(dir, 'result.json')
    writeFileSync(requestFile, JSON.stringify(request))

    const bin = join(circuitsDir, 'node_modules', '.bin')
    const path = [bin, bbDirectory(), process.env.PATH].filter(Boolean).join(delimiter)
    await run(join(bin, 'tsx'), [join(here, 'prove-mock.cts'), requestFile, resultFile], {
      cwd: circuitsDir,
      env: { ...process.env, PATH: path },
      maxBuffer: 256 * 1024 * 1024,
    })

    return JSON.parse(readFileSync(resultFile, 'utf8')) as T
  } catch (error) {
    // The prover prints its own failure to stderr; surface it instead of the bare "Command failed".
    const stderr = error instanceof Error && 'stderr' in error ? String(error.stderr) : String(error)
    throw new Error(`The mock ZKPassport prover failed:\n${stderr}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

/** What a registry must hold for the mock proofs to verify; known without proving anything. */
export type MockRegistryRoots = {
  circuitsVersion: string
  certificateRoot: string
  circuitRoot: string
  /** The `outer_count_4` (`register`), `outer_count_5` (`register_with_age`, `register_with_nationality`) and `outer_count_6` (both) verification key hashes. */
  vkeyHashes: { outer_count_4: string; outer_count_5: string; outer_count_6: string }
}

/**
 * The registry roots and outer vk hashes of the mock proofs: the certificate root of the (cached) synthetic authority and
 * the circuit root and vk hashes of circuits release 0.22.0. `seedLocalRegistry` takes them.
 */
export const mockRegistryRoots = async (): Promise<MockRegistryRoots> => {
  const result = await runProver<{
    circuitVersion: string
    certificateRegistryRoot: string
    circuitRegistryRoot: string
    vkeyHashes: MockRegistryRoots['vkeyHashes']
  }>({ mode: 'roots' })

  return {
    circuitsVersion: result.circuitVersion,
    certificateRoot: result.certificateRegistryRoot,
    circuitRoot: result.circuitRegistryRoot,
    vkeyHashes: result.vkeyHashes,
  }
}

/**
 * Prove a real ZKPassport outer proof of a synthetic mock-country document, bound to `aztecAddress`, `domain` and `scope`.
 * Every subproof (certificate, ID data, integrity, age, bind) is proved with bb 6.0.0 and aggregated by the published
 * `outer_count_4`/`outer_count_5` circuit of release 0.22.0, exactly as the ZKPassport app does; only the passport and the
 * certificate authority that signed it are synthetic. Takes about half a minute. The circuits are downloaded on first use.
 */
export const generateMockRegistrationProof = async (options: MockRegistrationProofOptions): Promise<MockRegistrationProof> => {
  const now = Number(options.now)
  const year = new Date(now * 1000).getUTCFullYear()
  const result = await runProver<ProverResult>({
    aztecAddress: options.aztecAddress,
    domain: options.domain.toString(),
    scope: scopeHash(options.scope).toString(),
    minAge: options.minAge ?? 0,
    nationality: options.nationality,
    now,
    documentNumber: (options.documentNumber ?? 'ZKR000001').padEnd(9, '<'),
    birthDate: options.birthDate ?? '881112',
    // The circuits resolve a two-digit expiry year within MAX_DOCUMENT_VALIDITY_YEARS of `now`: stay well inside it.
    expiryDate: `${String((year + 5) % 100).padStart(2, '0')}0101`,
  })
  if (result.circuitVersion !== CIRCUITS_VERSION) throw new Error(`Proved with circuits ${result.circuitVersion}, expected ${CIRCUITS_VERSION}`)

  return {
    circuit: result.circuit,
    subproofs: Number(result.circuit.slice('outer_count_'.length)) as 4 | 5 | 6,
    proof: [...result.publicInputs, ...result.proofFields].map(bare).join(''),
    vkeyHash: result.vkeyHash,
    vkeyFields: result.vkeyFields,
    proofFields: result.proofFields,
    publicInputs: result.publicInputs,
    certificateRoot: result.certificateRegistryRoot,
    circuitRoot: result.circuitRegistryRoot,
    circuitsVersion: result.circuitVersion,
    now: result.now,
    nullifierType: result.nullifierType,
    scopedNullifier: result.scopedNullifier,
  }
}
