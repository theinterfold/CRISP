// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

// @ts-nocheck -- runs inside the zkpassport/circuits checkout (.cache/circuits, see scripts/setup-circuits.mjs): it imports
// that repository's sources and node_modules, which only exist after setup, so it cannot be type-checked from here.
//
// Proves a REAL ZKPassport outer proof (outer_count_4 / outer_count_5, bb 6.0.0, poseidon2 UltraHonk ZK) for a synthetic
// passport of the mock country ZKR. It is the flow of zkpassport-packages `packages/aztec/test-harness/
// generate-proof-fixtures.ts`, parameterised for CRISP: bound to an Aztec address, to a domain and a scope, dated `now`.
//
// Usage (through generateMockRegistrationProof, which sets cwd, PATH and arguments):
//   tsx src/prove-mock.cts <request.json> <result.json>
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { createRequire } from 'node:module'

const CIRCUITS = path.resolve(__dirname, '..', '.cache', 'circuits')
// The circuits checkout does not exist until setup has run, so its modules cannot be imported statically. They are loaded
// through its own CommonJS resolution so that this script and the checkout's test helpers share one copy of each package.
const circuitsRequire = createRequire(path.join(CIRCUITS, 'package.json'))

const { poseidon2HashAsync } = circuitsRequire('@zkpassport/poseidon2')
const utils = circuitsRequire('@zkpassport/utils')
const generator = circuitsRequire('@zkpassport/utils/passport-generator')
const { AlgorithmIdentifier, Certificate } = circuitsRequire('@peculiar/asn1-x509')
const { AsnConvert } = circuitsRequire('@peculiar/asn1-schema')
const { id_sha256WithRSAEncryption } = circuitsRequire('@peculiar/asn1-rsa')
const { Circuit } = circuitsRequire(path.join(CIRCUITS, 'src/ts/circuits.ts'))
const { TestHelper, convertPemToPackagedCertificateV1 } = circuitsRequire(path.join(CIRCUITS, 'src/ts/test-helper.ts'))
const { serializeAsn } = circuitsRequire(path.join(CIRCUITS, 'src/ts/utils.ts'))

const {
  Binary,
  calculatePackagedCertificatesRoot,
  getAgeCircuitInputs,
  getAgeParameterCommitment,
  getBindCircuitInputs,
  getBindParameterCommitment,
  getCountryParameterCommitment,
  getNationalityExclusionCircuitInputs,
  getNationalityInclusionCircuitInputs,
  ProofType,
  formatBoundData,
  getCircuitMerkleProof,
  getCommitmentFromDSCProof,
  getCommitmentInFromDisclosureProof,
  getCommitmentInFromIDDataProof,
  getCommitmentInFromIntegrityProof,
  getCommitmentOutFromIDDataProof,
  getCommitmentOutFromIntegrityProof,
  getMerkleRootFromDSCProof,
  getOuterCircuitInputs,
  getParameterCommitmentFromDisclosureProof,
} = utils
const { generateSigningCertificates, generateSod, loadKeypairFromFile, signSod, wrapSodInContentInfo } = generator

const CACHE = path.resolve(CIRCUITS, '..')
const CIRCUITS_CDN = 'https://circuits2.zkpassport.id/testnet'
const CIRCUIT_VERSION: string = JSON.parse(fs.readFileSync(path.join(CIRCUITS, 'package.json'), 'utf8')).version
/** Max padded TBS length the sig-check circuits accept; 700 fits the synthetic certificates. */
const MAX_TBS_LENGTH = 700
/** Both disclosure stages must hash the carried passport data with the same salts. */
const SALTS = { dg1Salt: 3n, expiryDateSalt: 3n, dg2HashSalt: 3n, privateNullifierSalt: 3n }

const log = (...args: unknown[]) => console.error(new Date().toISOString(), ...args)
const assert = (condition: boolean, message: string) => {
  if (!condition) throw new Error(`ASSERT FAILED: ${message}`)
}
const hex = (value: bigint) => `0x${value.toString(16).padStart(64, '0')}`

type Request = {
  /** `roots`: only report what a registry must hold for this authority and release; nothing is proved. */
  mode?: 'roots'
  /** 32-byte hex: the account the proof is bound to (`bind_user_address`). */
  aztecAddress: string
  /** `domain` public input: the contract's `zkpassport_domain` hash, decimal or 0x string. */
  domain: string
  /** `scope` (subscope) public input: the round's scope hash, decimal or 0x string. */
  scope: string
  /** Minimum age to prove; 0 proves no age. */
  minAge: number
  /** A nationality rule to prove: `mode` 1 = nationality in `countries` (alpha-3, given order), 2 = not in them. Omit for none. */
  nationality?: { mode: 1 | 2; countries: string[] }
  /** `current_date` of the proof, Unix seconds. */
  now: number
  /** 9 characters of the MRZ document number; a different one is a different document (a different nullifier). */
  documentNumber: string
  /** Date of birth, YYMMDD. */
  birthDate: string
  /** Expiry date, YYMMDD. */
  expiryDate: string
}

type Subproof = { proof: string[]; publicInputs: string[]; vkey: string[]; vkeyHash: string; paramCommitment?: bigint }

const fetchJson = async <T>(url: string): Promise<T> => {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`GET ${url}: ${response.status} ${response.statusText}`)
  return (await response.json()) as T
}

/** The CDN download for `url`, kept under .cache/downloads so a run needs the network only the first time. */
const cachedJson = async <T>(name: string, url: string): Promise<T> => {
  const file = path.join(CACHE, 'downloads', name)
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')) as T
  const value = await fetchJson<T>(url)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(value))
  return value
}

let manifest: { version: string; root: string; circuits: Record<string, { hash: string }> }

const packagedCircuit = async (name: string) => {
  const hash = manifest.circuits[name]?.hash
  assert(!!hash, `${name} is in the ${manifest.version} manifest`)
  const packaged = await cachedJson<{ name: string }>(`circuit-${hash}.json`, `${CIRCUITS_CDN}/by-hash/${hash}.json`)
  assert(packaged.name === name, `packaged circuit ${hash} is ${name} (got ${packaged.name})`)
  return packaged
}

const proveSubproof = async (name: string, inputs: unknown) => {
  const circuit = new Circuit(await packagedCircuit(name), name)
  log(`proving ${name} ...`)
  const proof = await circuit.prove(inputs, { recursive: true, useCli: true, circuitName: name })
  const vkey = (await circuit.getVerificationKey({ evm: false })).vkeyFields
  const vkeyHash = hex(await poseidon2HashAsync(vkey.map((x: string) => BigInt(x))))
  assert(vkeyHash === manifest.circuits[name].hash, `${name} vk hash == the manifest's`)
  await circuit.destroy()
  return { proof, vkey, vkeyHash }
}

const toSubproof = (s: { proof: { proof: string[]; publicInputs: string[] }; vkey: string[]; vkeyHash: string }): Subproof => ({
  proof: s.proof.proof,
  publicInputs: s.proof.publicInputs,
  vkey: s.vkey,
  vkeyHash: s.vkeyHash,
})

const subproofInput = (s: Subproof, merkle: { index: number; path: string[] }) => ({
  proof: s.proof,
  publicInputs: s.publicInputs,
  vkey: s.vkey,
  keyHash: s.vkeyHash,
  treeHashPath: merkle.path,
  treeIndex: merkle.index.toString(),
})

/**
 * The synthetic certificate authority and the document signing certificate it issued. The certificate registry root is a
 * hash of the authority, so it is generated once and kept: a fresh one per run would need a new registry root (and a 24 hour
 * registry delay) per proof.
 */
const loadPki = async () => {
  const file = path.join(CACHE, 'pki.json')
  if (!fs.existsSync(file)) {
    log('generating the synthetic ZKR certificate authority (once) ...')
    const dscKeypair = await loadKeypairFromFile(path.join(CIRCUITS, 'src/ts/tests/fixtures/dsc-keypair-rsa.json'))
    const { cscPem, dscPem } = await generateSigningCertificates({
      cscSigningHashAlgorithm: 'SHA-512',
      cscKeyType: 'RSA',
      cscKeySize: 4096,
      dscSigningHashAlgorithm: 'SHA-256',
      dscKeyType: 'RSA',
      dscKeySize: 2048,
      dscKeypair,
      issuingCountry: 'ZK',
    })
    fs.writeFileSync(file, JSON.stringify({ cscPem, dscPem }))
  }
  const { cscPem, dscPem } = JSON.parse(fs.readFileSync(file, 'utf8')) as { cscPem: string; dscPem: string }
  const der = Buffer.from(dscPem.replace(/-----(BEGIN|END) CERTIFICATE-----/g, '').replace(/\s+/g, ''), 'base64')
  return {
    cscPem,
    dsc: AsnConvert.parse(new Uint8Array(der), Certificate),
    dscKeys: await loadKeypairFromFile(path.join(CIRCUITS, 'src/ts/tests/fixtures/dsc-keypair-rsa.json')),
  }
}

const mrzOf = (request: Request) => {
  assert(/^[A-Z0-9<]{9}$/.test(request.documentNumber), 'documentNumber is 9 characters of A-Z, 0-9, <')
  assert(/^\d{6}$/.test(request.birthDate) && /^\d{6}$/.test(request.expiryDate), 'birthDate and expiryDate are YYMMDD')
  // ICAO 9303 TD3, both lines 44 characters; the check digits are placeholders as in the circuits' own test passport.
  // ZKR is the mock country: it makes the proof's nullifier type NON_SALTED_MOCK.
  const line1 = 'P<ZKRSILVERHAND<<JOHNNY'.padEnd(44, '<')
  const line2 = `${request.documentNumber}_ZKR${request.birthDate}_M${request.expiryDate}_<CYBERCITY<<<<`
  return `${line1}${line2}\0\0`
}

/** The certificate registry the synthetic authority forms: one certificate, so its root is fixed by the cached authority. */
const packagedCertificates = async (cscPem: string) => {
  const packaged = { version: 1, timestamp: Math.floor(Date.UTC(2026, 0, 1) / 1000), root: '', certificates: [], masterlists: [], revocations: [] }
  packaged.certificates.push(await convertPemToPackagedCertificateV1(cscPem))
  packaged.root = await calculatePackagedCertificatesRoot(packaged)

  return packaged
}

const main = async () => {
  const [requestFile, resultFile] = process.argv.slice(2)
  const request: Request = JSON.parse(fs.readFileSync(requestFile, 'utf8'))
  manifest = await cachedJson(`manifest-${CIRCUIT_VERSION}.json`, `${CIRCUITS_CDN}/by-version/${CIRCUIT_VERSION}/manifest.json`)
  assert(manifest.version === CIRCUIT_VERSION, `manifest version ${manifest.version} == ${CIRCUIT_VERSION}`)

  if (request.mode === 'roots') {
    // What a registry must hold for proofs of this authority and release to verify; needs no proving.
    const { cscPem } = await loadPki()
    const outer = (name: string) => manifest.circuits[name].hash
    fs.writeFileSync(
      resultFile,
      JSON.stringify({
        circuitVersion: CIRCUIT_VERSION,
        certificateRegistryRoot: (await packagedCertificates(cscPem)).root,
        circuitRegistryRoot: manifest.root,
        vkeyHashes: { outer_count_4: outer('outer_count_4'), outer_count_5: outer('outer_count_5'), outer_count_6: outer('outer_count_6') },
      }),
    )
    return
  }

  const domain = BigInt(request.domain)
  const scope = BigInt(request.scope)
  const now = request.now
  const withAge = request.minAge > 0
  const bbVersion = execFileSync('bb', ['--version']).toString().trim().split('\n').pop()
  assert(bbVersion === '6.0.0', `bb 6.0.0 must be first on PATH (found ${bbVersion})`)
  log(`bb ${bbVersion}, circuits ${CIRCUIT_VERSION}, age ${request.minAge}, now ${now}`)

  // ---- The passport: a ZKR document signed by the synthetic authority ----
  const { cscPem, dsc, dscKeys } = await loadPki()
  const dg1 = Binary.fromHex('615B5F1F58').concat(Binary.from(mrzOf(request)))
  const { sod } = await generateSod(dg1, [dsc], 'SHA-256', new AlgorithmIdentifier({ algorithm: id_sha256WithRSAEncryption }))
  const { sod: signedSod } = await signSod(sod, dscKeys, 'SHA-256')
  const packagedCerts = await packagedCertificates(cscPem)

  const helper = new TestHelper()
  await helper.loadPassport(dg1, Binary.from(serializeAsn(wrapSodInContentInfo(signedSod))))
  helper.setCertificates(packagedCerts)

  // ---- Subproof chain: DSC -> ID data -> integrity -> age? + bind ----
  // The DSC proof depends on the authority only, so it is proven once and kept.
  const dscName = `sig_check_dsc_tbs_${MAX_TBS_LENGTH}_rsa_pkcs_4096_sha512`
  const dscFile = path.join(CACHE, `dsc-proof-${manifest.circuits[dscName].hash.slice(2, 14)}-${createHash('sha256').update(cscPem).digest('hex').slice(0, 12)}.json`)
  let dscR: { proof: { proof: string[]; publicInputs: string[] }; vkey: string[]; vkeyHash: string }
  if (fs.existsSync(dscFile)) {
    dscR = JSON.parse(fs.readFileSync(dscFile, 'utf8'))
  } else {
    dscR = await proveSubproof(dscName, await helper.generateCircuitInputs('dsc'))
    fs.writeFileSync(dscFile, JSON.stringify(dscR))
  }
  assert(dscR.proof.publicInputs.length === 2, 'dsc publicInputs length == 2')
  const certificateRegistryRoot: bigint = getMerkleRootFromDSCProof(dscR.proof)
  const cscToDscCommitment = getCommitmentFromDSCProof(dscR.proof)

  const idR = await proveSubproof(`sig_check_id_data_tbs_${MAX_TBS_LENGTH}_rsa_pkcs_2048_sha256`, await helper.generateCircuitInputs('id'))
  assert(getCommitmentInFromIDDataProof(idR.proof) === cscToDscCommitment, 'id commitment_in == dsc commitment_out')

  const integrityR = await proveSubproof('data_check_integrity_sa_sha256_dg_sha256', await helper.generateCircuitInputs('integrity', now))
  assert(getCommitmentInFromIntegrityProof(integrityR.proof) === getCommitmentOutFromIDDataProof(idR.proof), 'integrity commitment_in == id commitment_out')
  const integrityToDisclosure = getCommitmentOutFromIntegrityProof(integrityR.proof)

  const disclosures: { name: string; subproof: Subproof }[] = []
  const chainCheck = (name: string, r: { proof: { proof: string[]; publicInputs: string[] } }) =>
    assert(getCommitmentInFromDisclosureProof(r.proof) === integrityToDisclosure, `${name} commitment_in == integrity commitment_out`)

  if (withAge) {
    const ageInputs = await getAgeCircuitInputs(helper.passport, { age: { gte: request.minAge } }, SALTS, 0n, domain, scope, now)
    assert(!!ageInputs, 'age inputs generated')
    assert(Number(ageInputs.min_age_required) === request.minAge && Number(ageInputs.max_age_required) === 0, 'age bounds as asked')
    const r = await proveSubproof('compare_age', ageInputs)
    chainCheck('compare_age', r)
    const paramCommitment = getParameterCommitmentFromDisclosureProof(r.proof)
    assert((await getAgeParameterCommitment(request.minAge, 0)) === paramCommitment, 'age param commitment reproduced')
    disclosures.push({ name: 'compare_age', subproof: { ...toSubproof(r), paramCommitment } })
  }

  if (request.nationality) {
    // The mock document's nationality is ZKR (its MRZ), so `in [..ZKR..]` and `not in [..other..]` hold.
    const { mode, countries } = request.nationality
    const inclusion = mode === 1
    const name = inclusion ? 'inclusion_check_nationality' : 'exclusion_check_nationality'
    const inputs = inclusion
      ? await getNationalityInclusionCircuitInputs(helper.passport, { nationality: { in: countries } }, SALTS, 0n, domain, scope, now)
      : await getNationalityExclusionCircuitInputs(helper.passport, { nationality: { out: countries } }, SALTS, 0n, domain, scope, now)
    assert(!!inputs, 'nationality inputs generated')
    const r = await proveSubproof(name, inputs)
    chainCheck(name, r)
    const paramCommitment = getParameterCommitmentFromDisclosureProof(r.proof)
    const expected = await getCountryParameterCommitment(inclusion ? ProofType.NATIONALITY_INCLUSION : ProofType.NATIONALITY_EXCLUSION, countries, !inclusion)
    assert(expected === paramCommitment, 'nationality param commitment reproduced')
    disclosures.push({ name, subproof: { ...toSubproof(r), paramCommitment } })
  }

  const bindInputs = await getBindCircuitInputs(helper.passport, { bind: { user_address: request.aztecAddress } }, SALTS, 0n, domain, scope, now)
  assert(!!bindInputs, 'bind inputs generated')
  const bindR = await proveSubproof('bind', bindInputs)
  chainCheck('bind', bindR)
  const bindCommitment = getParameterCommitmentFromDisclosureProof(bindR.proof)
  assert((await getBindParameterCommitment(formatBoundData({ user_address: request.aztecAddress }))) === bindCommitment, 'bind param commitment reproduced')
  disclosures.push({ name: 'bind', subproof: { ...toSubproof(bindR), paramCommitment: bindCommitment } })

  // ---- Outer proof ----
  const outerName = `outer_count_${3 + disclosures.length}`
  const chain = [toSubproof(dscR), toSubproof(idR), toSubproof(integrityR)]
  const merkle = []
  for (const s of [...chain, ...disclosures.map((d) => d.subproof)]) merkle.push(await getCircuitMerkleProof(s.vkeyHash, manifest))
  assert(merkle[0].root === manifest.root, `the manifest's circuits hash to its root ${manifest.root}`)

  const outerInputs = await getOuterCircuitInputs(
    subproofInput(chain[0], merkle[0]),
    subproofInput(chain[1], merkle[1]),
    subproofInput(chain[2], merkle[2]),
    disclosures.map((d, i) => subproofInput(d.subproof, merkle[3 + i])),
    manifest.root,
  )
  const outerPackaged = await packagedCircuit(outerName)
  const outerCircuit = new Circuit(outerPackaged, outerName)
  log(`proving ${outerName} ...`)
  const outer = await outerCircuit.prove(outerInputs, { useCli: true, circuitName: outerName, recursive: true })
  const outerVkey: string[] = (await outerCircuit.getVerificationKey({ evm: false })).vkeyFields
  const outerVkeyHash = hex(await poseidon2HashAsync(outerVkey.map((x) => BigInt(x))))
  await outerCircuit.destroy()
  assert(outerVkeyHash === manifest.circuits[outerName].hash, `${outerName} vk hash == the manifest's`)

  // Public inputs: [certRoot, circuitRoot, currentDate, domain, scope, paramCommitments(K-3)..., nullifierType, scopedNullifier, oprfPkHash]
  const publicInputs: string[] = outer.publicInputs
  const k = disclosures.length + 3
  assert(publicInputs.length === k + 5, `outer public inputs: ${publicInputs.length} == ${k + 5}`)
  assert(certificateRegistryRoot === BigInt(packagedCerts.root), 'the DSC proof commits to the authority the registry will hold')
  assert(BigInt(publicInputs[2]) === BigInt(now), 'current_date public input == now')
  assert(BigInt(publicInputs[3]) === domain && BigInt(publicInputs[4]) === scope, 'domain and scope public inputs as asked')
  const expected = new Set(disclosures.map((d) => d.subproof.paramCommitment))
  const got = new Set(publicInputs.slice(5, 5 + expected.size).map(BigInt))
  assert(got.size === expected.size && [...expected].every((c) => got.has(c)), 'outer param commitments == the subproofs')

  fs.writeFileSync(
    resultFile,
    JSON.stringify(
      {
        circuit: outerName,
        circuitVersion: CIRCUIT_VERSION,
        now,
        certificateRegistryRoot: hex(certificateRegistryRoot),
        circuitRegistryRoot: manifest.root,
        vkeyHash: outerVkeyHash,
        nullifierType: Number(BigInt(publicInputs[k + 5 - 3])),
        scopedNullifier: publicInputs[k + 5 - 2],
        vkeyFields: outerVkey,
        proofFields: outer.proof,
        publicInputs,
      },
      null,
      2,
    ),
  )
  log(`${outerName} proof written to ${resultFile}`)
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error)
    process.exit(1)
  },
)
