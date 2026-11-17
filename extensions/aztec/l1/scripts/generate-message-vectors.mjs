// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

// Regenerates tests/fixtures/message-vectors.json: the byte-exact contract between CRISPAztecProgram (L1), the
// `crisp_aztec` Noir contract, the TypeScript SDK and the Rust ingest. Run `node scripts/generate-message-vectors.mjs`.
//
// The ids are a real Interfold's: `e3Id = uint160(interfold) << 96 | roundId`, which does not fit a field element, so
// the messages carry `roundId` while the scope string (and every L1 / server digest) keeps the full `e3Id`.
import { writeFileSync } from 'node:fs'
import { AbiCoder, getAddress, sha256, toBeHex, toUtf8Bytes, zeroPadValue } from 'ethers'

const abi = AbiCoder.defaultAbiCoder()
const sha256ToField = (bytes) => zeroPadValue(toBeHex(BigInt(sha256(bytes)) >> 8n), 32)
const decimal = (hex) => BigInt(hex).toString()

const interfold = getAddress('0xdFa59d66c173A00643eBE80e172Af5a8Cf244b30')
const roundId = 7n
const e3Id = (BigInt(interfold) << 96n) | roundId
const program = '0x1111111111111111111111111111111111111111'
const chainId = 31337

const scopeString = `crisp-aztec:${chainId}:${program}:${e3Id}`
const scopeHash = zeroPadValue(toBeHex(BigInt(sha256(toUtf8Bytes(scopeString))) >> 8n), 32)

const round = {
  roundId: Number(roundId),
  numOptions: 3,
  credits: 100,
  inputStart: 1700000000,
  inputEnd: 1700003600,
  inputLimit: 65536,
  scopeHash: decimal(scopeHash),
  minAge: 18,
  allowMockDocuments: true,
}
const roundBytes = abi.encode(Array(10).fill('uint256'), [
  1,
  round.roundId,
  round.numOptions,
  round.credits,
  round.inputStart,
  round.inputEnd,
  round.inputLimit,
  scopeHash,
  round.minAge,
  1,
])

const committeePublicKey = '0x0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20'
const keyBytes = abi.encode(['uint256', 'uint256', 'bytes32'], [2, roundId, committeePublicKey])

const inputRoot = '0x2098f5fb9e239eab3ceac3f27b81e481dc3124d55ffed523a839ee8446b64864'
const numInputs = 5
const rootBytes = abi.encode(['uint256', 'uint256', 'uint256', 'uint256'], [3, roundId, inputRoot, numInputs])

const entry = (fields, abiEncoded) => {
  const content = sha256ToField(abiEncoded)

  return { fields, abiEncoded, content, contentDecimal: decimal(content) }
}

const vectors = {
  description:
    'Message contents exchanged between CRISPAztecProgram (L1) and crisp_aztec (L2). content = sha256ToField(abi.encode(...)) = 0x00 || sha256(bytes)[0..31]. Word 2 of every message is the roundId: the low 96 bits of the e3Id.',
  secretHash: {
    secret: '0',
    value: '0x1f8eff65d91ed781c2e7a28a2ff99b7f7506b7293121b5ffcf3cd339c84d2250',
  },
  ids: {
    interfold,
    e3Id: toBeHex(e3Id, 32),
    e3IdDecimal: e3Id.toString(),
    roundId: Number(roundId),
    description: 'e3Id = uint160(interfold) << 96 | roundId. It exceeds the BN254 modulus, which is why messages carry roundId.',
  },
  scope: {
    chainId,
    program,
    e3Id: e3Id.toString(),
    string: scopeString,
    hash: scopeHash,
    hashDecimal: decimal(scopeHash),
  },
  round: entry(round, roundBytes),
  key: entry({ roundId: Number(roundId), committeePublicKey }, keyBytes),
  root: entry({ roundId: Number(roundId), inputRoot, numInputs }, rootBytes),
}

writeFileSync(new URL('../tests/fixtures/message-vectors.json', import.meta.url), `${JSON.stringify(vectors, null, 2)}\n`)
console.log('wrote tests/fixtures/message-vectors.json')
