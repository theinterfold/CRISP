// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { readFileSync } from 'node:fs'
import { expect } from 'chai'
import { deployFixture, ethers, FIELD_MODULUS, sha256ToField } from './utils'

const vectors = JSON.parse(readFileSync(new URL('./fixtures/message-vectors.json', import.meta.url), 'utf8'))

// The same fixture is the contract with the `crisp_aztec` Noir contract and the TypeScript SDK: they assert their own
// encoders against these literals.
describe('message vectors', function () {
  it('encodes the ROUND, KEY and ROOT messages byte for byte', async function () {
    const harness = await ethers.deployContract('MessageVectorsHarness')

    for (const kind of ['round', 'roundNoRule']) {
      const round = await harness.round({ ...vectors[kind].fields })
      expect(round).to.equal(vectors[kind].abiEncoded)
      expect(sha256ToField(round)).to.equal(vectors[kind].content)
    }

    const key = await harness.committeeKey(vectors.key.fields.roundId, vectors.key.fields.committeePublicKey)
    expect(key).to.equal(vectors.key.abiEncoded)
    expect(sha256ToField(key)).to.equal(vectors.key.content)

    const root = await harness.inputRoot(vectors.root.fields.roundId, vectors.root.fields.inputRoot, vectors.root.fields.numInputs)
    expect(root).to.equal(vectors.root.abiEncoded)
    expect(sha256ToField(root)).to.equal(vectors.root.content)
  })

  it("hashes message contents with the program's sha256ToField", async function () {
    const { program } = await deployFixture()
    for (const kind of ['round', 'roundNoRule', 'key', 'root']) {
      expect(await program.sha256ToField(vectors[kind].abiEncoded)).to.equal(vectors[kind].content)
      expect(BigInt(vectors[kind].content).toString()).to.equal(vectors[kind].contentDecimal)
    }
  })

  it('derives the scope string and its field-sized hash', async function () {
    const { scope } = vectors
    expect(scope.string).to.equal(`crisp-aztec:${scope.chainId}:${scope.program}:${scope.e3Id}`)
    expect(BigInt(ethers.sha256(ethers.toUtf8Bytes(scope.string))) >> 8n).to.equal(BigInt(scope.hash))

    // The program derives the same string from its own address and the chain it runs on.
    const { program } = await deployFixture()
    const chainId = (await ethers.provider.getNetwork()).chainId
    const expected = `crisp-aztec:${chainId}:${(await program.getAddress()).toLowerCase()}:9`
    expect(await program.scopeOf(9)).to.equal(expected)
    expect(await program.scopeHashOf(9)).to.equal(BigInt(ethers.sha256(ethers.toUtf8Bytes(expected))) >> 8n)
  })

  it('derives the round id from an e3Id that does not fit a field element', async function () {
    const { ids } = vectors
    expect(BigInt(ids.e3Id) >> 96n).to.equal(BigInt(ids.interfold))
    expect(BigInt.asUintN(96, BigInt(ids.e3Id))).to.equal(BigInt(ids.roundId))
    expect(BigInt(ids.e3Id)).to.be.greaterThan(FIELD_MODULUS)
    expect(ids.e3IdDecimal).to.equal(BigInt(ids.e3Id).toString())
    expect(BigInt(vectors.scope.e3Id)).to.equal(BigInt(ids.e3Id))
  })

  it('pins the secret hash of secret 0', async function () {
    const { program } = await deployFixture()
    expect(await program.SECRET_HASH()).to.equal(vectors.secretHash.value)
  })
})
