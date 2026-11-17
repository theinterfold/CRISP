// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { readFileSync } from 'node:fs'
import { expect } from 'chai'
import type { ContractTransactionReceipt } from 'ethers'
import {
  abiCoder,
  customParams,
  type CustomParamsInput,
  defaultWindow,
  deployFixture,
  deployRegistrar,
  ethers,
  FIELD_MODULUS,
  type Fixture,
  increaseTimeTo,
  PROOF_VALIDITY,
  sha256ToField,
  ZKPASSPORT_DOMAIN,
} from './utils'

const vectors = JSON.parse(readFileSync(new URL('./fixtures/message-vectors.json', import.meta.url), 'utf8'))

async function request(f: Fixture, params: string, window?: [number, number]) {
  const inputWindow = window ?? (await defaultWindow())
  const programAddress = await f.program.getAddress()
  const e3Id = BigInt(await f.interfold.request.staticCall(programAddress, inputWindow, params))
  const tx = await f.interfold.request(programAddress, inputWindow, params)
  return { e3Id, inputWindow, tx, receipt: (await tx.wait()) as ContractTransactionReceipt }
}

/** The one real-Inbox `MessageSent` event in `receipt`. */
function inboxMessage(f: Fixture, receipt: ContractTransactionReceipt) {
  const parsed = receipt.logs
    .map((log) => {
      try {
        return f.inbox.interface.parseLog(log)
      } catch {
        return null
      }
    })
    .filter((p) => p?.name === 'MessageSent')
  expect(parsed).to.have.length(1)
  return parsed[0]!.args
}

const SLOT = '0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed'
const OTHER_SLOT = '0x1111111111111111111111111111111111111111'

interface ProofOptions {
  slot?: string
  chainId?: bigint
  age?: number
  nationality?: string
  document?: string
  salted?: boolean
  proof?: string
}

/** What the mock root verifier and helper read; the service configuration is deliberately wrong, the registrar replaces it. */
function proofParams(o: ProofOptions = {}) {
  const {
    slot = SLOT,
    chainId = 31337n,
    age = 30,
    nationality = 'DEU',
    document = ethers.id('document-1'),
    salted = false,
    proof = '0x01',
  } = o
  return {
    version: ethers.id('version'),
    proofVerificationData: {
      vkeyHash: ethers.id('vkey'),
      proof,
      publicInputs: [document, salted ? ethers.id('salted') : ethers.ZeroHash],
    },
    committedInputs: abiCoder.encode(['address', 'uint256', 'uint256', 'string'], [slot, chainId, age, nationality]),
    serviceConfig: { validityPeriodInSeconds: 1, domain: 'evil.example', scope: 'other', devMode: false },
  }
}

/** `n` distinct three-letter codes. */
function countryCodes(n: number): string[] {
  return Array.from({ length: n }, (_, i) =>
    String.fromCharCode(65 + (i % 26), 65 + (Math.floor(i / 26) % 26), 65 + (Math.floor(i / 676) % 26)),
  )
}

describe('L1 registration (ZKPassportRegistrar)', function () {
  async function setup(rules: CustomParamsInput = {}, window?: [number, number]) {
    const f = await deployFixture()
    const { registrar, verifier } = await deployRegistrar(f)
    const round = await request(f, customParams({ ...rules, registrar: await registrar.getAddress() }), window)
    return { f, registrar, verifier, ...round }
  }

  describe('custom params', function () {
    it('accepts the Aztec path with no rule, and with a nationality commitment', async function () {
      const f = await deployFixture()
      await request(f, customParams())
      const commitment = BigInt(vectors.round.fields.nationalityCommitment)
      const { tx, e3Id } = await request(
        f,
        customParams({ nationalityMode: 1, countries: ['DEU', 'FRA'], nationalityCommitment: commitment }),
      )
      await expect(tx).to.emit(f.program, 'RoundRules').withArgs(e3Id, ethers.ZeroAddress, 18, true, 1, ['DEU', 'FRA'], commitment)
      const rules = await f.program.getRules(e3Id)
      expect(rules.registrar).to.equal(ethers.ZeroAddress)
      expect(rules.nationalityMode).to.equal(1n)
      expect(rules.countriesHash).to.equal(ethers.keccak256(abiCoder.encode(['string[]'], [['DEU', 'FRA']])))
    })

    it('sends the L1-registration ROUND message and records the rules', async function () {
      const f = await deployFixture()
      const { registrar } = await deployRegistrar(f)
      const registrarAddress = await registrar.getAddress()
      const { e3Id, inputWindow, tx, receipt } = await request(
        f,
        customParams({ registrar: registrarAddress, nationalityMode: 2, countries: ['PRK'], minAge: 21n, allowMockDocuments: false }),
      )
      const scopeHash = await f.program.scopeHashOf(e3Id)
      const expected = abiCoder.encode(Array(13).fill('uint256'), [
        1,
        BigInt.asUintN(96, e3Id),
        3,
        100,
        inputWindow[0],
        inputWindow[1],
        65536,
        scopeHash,
        21,
        0,
        1,
        2,
        0,
      ])
      expect(inboxMessage(f, receipt).message.content).to.equal(sha256ToField(expected))
      await expect(tx).to.emit(f.program, 'RoundRules').withArgs(e3Id, registrarAddress, 21, false, 2, ['PRK'], 0)

      const rules = await f.program.getRules(e3Id)
      expect(rules.registrar).to.equal(registrarAddress)
      expect(rules.allowMockDocuments).to.equal(false)
      expect(rules.nationalityMode).to.equal(2n)
      expect(rules.minAge).to.equal(21n)
      expect(rules.inputEnd).to.equal(BigInt(inputWindow[1]))
      expect(rules.countriesHash).to.equal(ethers.keccak256(abiCoder.encode(['string[]'], [['PRK']])))
    })

    it('refuses a registrar that is not a contract', async function () {
      const f = await deployFixture()
      await expect(request(f, customParams({ registrar: SLOT }))).to.be.revertedWithCustomError(f.program, 'InvalidRegistrar')
    })

    it('refuses an unknown nationality mode and country lists that do not fit the mode', async function () {
      const f = await deployFixture()
      const commitment = 5n
      const bad = (p: CustomParamsInput, error: string) =>
        expect(request(f, customParams(p))).to.be.revertedWithCustomError(f.program, error)

      await bad({ nationalityMode: 3, countries: ['DEU'], nationalityCommitment: commitment }, 'InvalidNationalityMode')
      // mode 0: no list
      await bad({ nationalityMode: 0, countries: ['DEU'] }, 'InvalidCountries')
      // mode 1 and 2: 1..200 entries
      await bad({ nationalityMode: 1, countries: [], nationalityCommitment: commitment }, 'InvalidCountries')
      await bad({ nationalityMode: 2, countries: [], nationalityCommitment: commitment }, 'InvalidCountries')
      await bad({ nationalityMode: 1, countries: countryCodes(201), nationalityCommitment: commitment }, 'InvalidCountries')
      // exactly three letters A-Z
      for (const code of ['DE', 'DEUT', 'deu', 'D<<', 'D1U', '']) {
        await bad({ nationalityMode: 1, countries: ['FRA', code], nationalityCommitment: commitment }, 'InvalidCountries')
      }
    })

    it('accepts 200 countries', async function () {
      const f = await deployFixture()
      await request(f, customParams({ nationalityMode: 2, countries: countryCodes(200), nationalityCommitment: 7n }))
    })

    it('checks the nationality commitment against the path', async function () {
      const f = await deployFixture()
      const { registrar } = await deployRegistrar(f)
      const registrarAddress = await registrar.getAddress()
      const bad = (p: CustomParamsInput) =>
        expect(request(f, customParams(p))).to.be.revertedWithCustomError(f.program, 'InvalidNationalityCommitment')

      // mode 0 carries none
      await bad({ nationalityCommitment: 1n })
      // Aztec path with a rule needs a field element
      await bad({ nationalityMode: 1, countries: ['DEU'], nationalityCommitment: 0n })
      await bad({ nationalityMode: 1, countries: ['DEU'], nationalityCommitment: FIELD_MODULUS })
      await bad({ nationalityMode: 2, countries: ['DEU'], nationalityCommitment: FIELD_MODULUS + 1n })
      await request(f, customParams({ nationalityMode: 2, countries: ['DEU'], nationalityCommitment: FIELD_MODULUS - 1n }))
      // L1 path: the registrar checks the list, so none is committed
      await bad({ registrar: registrarAddress, nationalityMode: 1, countries: ['DEU'], nationalityCommitment: 1n })
      await bad({ registrar: registrarAddress, nationalityCommitment: 1n })
      await request(f, customParams({ registrar: registrarAddress, nationalityMode: 1, countries: ['DEU'] }))
    })

    it('still enforces the age cap and the option count', async function () {
      const f = await deployFixture()
      await expect(request(f, customParams({ minAge: 100n }))).to.be.revertedWithCustomError(f.program, 'InvalidMinAge')
      await expect(request(f, customParams({ numOptions: 1n }))).to.be.revertedWithCustomError(f.program, 'InvalidNumOptions')
    })
  })

  describe('registrar deployment', function () {
    it('refuses a root verifier or program that is not a contract, an empty domain and a zero validity', async function () {
      const f = await deployFixture()
      const verifier = await (await ethers.deployContract('MockZKPassportVerifier')).getAddress()
      const program = await f.program.getAddress()
      const { registrar } = await deployRegistrar(f)
      const deploy = (...args: unknown[]) => ethers.deployContract('ZKPassportRegistrar', args)
      await expect(deploy(SLOT, program, ZKPASSPORT_DOMAIN, PROOF_VALIDITY)).to.be.revertedWithCustomError(registrar, 'InvalidConfig')
      await expect(deploy(verifier, SLOT, ZKPASSPORT_DOMAIN, PROOF_VALIDITY)).to.be.revertedWithCustomError(registrar, 'InvalidConfig')
      await expect(deploy(verifier, program, '', PROOF_VALIDITY)).to.be.revertedWithCustomError(registrar, 'InvalidConfig')
      await expect(deploy(verifier, program, ZKPASSPORT_DOMAIN, 0)).to.be.revertedWithCustomError(registrar, 'InvalidConfig')
    })

    it('exposes its configuration', async function () {
      const f = await deployFixture()
      const { registrar, verifier } = await deployRegistrar(f)
      expect(await registrar.program()).to.equal(await f.program.getAddress())
      expect(await registrar.rootVerifier()).to.equal(await verifier.getAddress())
      expect(await registrar.domain()).to.equal(ZKPASSPORT_DOMAIN)
      expect(await registrar.validityPeriod()).to.equal(PROOF_VALIDITY)
    })
  })

  describe('register', function () {
    it('verifies with the round’s service configuration and sends the voter’s slot to Aztec', async function () {
      const { f, registrar, verifier, e3Id } = await setup()
      const tx = await registrar.register(e3Id, SLOT, proofParams(), [])
      const receipt = (await tx.wait()) as ContractTransactionReceipt

      // The caller's service configuration is replaced with the poll's.
      const service = await verifier.lastServiceConfig()
      expect(service.validityPeriodInSeconds).to.equal(PROOF_VALIDITY)
      expect(service.domain).to.equal(ZKPASSPORT_DOMAIN)
      expect(service.scope).to.equal(await f.program.scopeOf(e3Id))
      expect(service.devMode).to.equal(true)

      // The MEMBER message the Aztec contract consumes: (4, roundId, slot).
      const { message, hash } = inboxMessage(f, receipt)
      const content = sha256ToField(abiCoder.encode(['uint256', 'uint256', 'uint256'], [4, BigInt.asUintN(96, e3Id), BigInt(SLOT)]))
      expect(message.content).to.equal(content)
      expect(message.recipient.actor).to.equal(f.l2Program)

      await expect(tx).to.emit(f.program, 'MemberSent').withArgs(e3Id, SLOT, message.index)
      await expect(tx).to.emit(f.program, 'L1ToL2MessageSent').withArgs(e3Id, content, hash, message.index)
      await expect(tx).to.emit(registrar, 'Registered').withArgs(e3Id, SLOT, ethers.id('document-1'))
      expect(await registrar.used(e3Id, ethers.id('document-1'))).to.equal(true)
    })

    it('matches the MEMBER vector for round id 7', async function () {
      const f = await deployFixture()
      const { registrar } = await deployRegistrar(f)
      let e3Id: bigint
      do e3Id = (await request(f, customParams({ registrar: await registrar.getAddress() }))).e3Id
      while (BigInt.asUintN(96, e3Id) < 7n)
      expect(BigInt.asUintN(96, e3Id)).to.equal(7n)

      const { slotAddress } = vectors.member.fields
      const receipt = (await (
        await registrar.register(e3Id, slotAddress, proofParams({ slot: slotAddress }), [])
      ).wait()) as ContractTransactionReceipt
      expect(inboxMessage(f, receipt).message.content).to.equal(vectors.member.content)
    })

    it('lets anyone submit the proof, since it binds the slot', async function () {
      const { registrar, e3Id } = await setup()
      const [, relayer] = await ethers.getSigners()
      await expect(registrar.connect(relayer).register(e3Id, SLOT, proofParams(), [])).to.emit(registrar, 'Registered')
    })

    it('registers a document once per round and lets it register for another round', async function () {
      const { f, registrar, e3Id } = await setup()
      await registrar.register(e3Id, SLOT, proofParams(), [])
      await expect(registrar.register(e3Id, OTHER_SLOT, proofParams({ slot: OTHER_SLOT }), []))
        .to.be.revertedWithCustomError(registrar, 'DocumentAlreadyRegistered')
        .withArgs(e3Id, ethers.id('document-1'))
      // another document may take another slot
      await registrar.register(e3Id, OTHER_SLOT, proofParams({ slot: OTHER_SLOT, document: ethers.id('document-2') }), [])

      const second = await request(f, customParams({ registrar: await registrar.getAddress() }))
      await registrar.register(second.e3Id, SLOT, proofParams(), [])
    })

    it('refuses a proof that does not bind the slot or this chain', async function () {
      const { registrar, e3Id } = await setup()
      await expect(registrar.register(e3Id, SLOT, proofParams({ slot: OTHER_SLOT }), []))
        .to.be.revertedWithCustomError(registrar, 'WrongBinding')
        .withArgs(OTHER_SLOT, 31337)
      await expect(registrar.register(e3Id, SLOT, proofParams({ chainId: 1n }), []))
        .to.be.revertedWithCustomError(registrar, 'WrongBinding')
        .withArgs(SLOT, 1)
    })

    it('refuses an invalid proof, a missing identifier and a salted identifier', async function () {
      const { registrar, e3Id } = await setup()
      await expect(registrar.register(e3Id, SLOT, proofParams({ proof: '0x' }), [])).to.be.revertedWithCustomError(
        registrar,
        'InvalidProof',
      )
      await expect(registrar.register(e3Id, SLOT, proofParams({ document: ethers.ZeroHash }), [])).to.be.revertedWithCustomError(
        registrar,
        'MissingIdentifier',
      )
      await expect(registrar.register(e3Id, SLOT, proofParams({ salted: true }), [])).to.be.revertedWithCustomError(
        registrar,
        'UnexpectedNullifierType',
      )
    })

    it('enforces the minimum age, and skips it when there is none', async function () {
      const { registrar, e3Id } = await setup({ minAge: 21n })
      await expect(registrar.register(e3Id, SLOT, proofParams({ age: 20 }), []))
        .to.be.revertedWithCustomError(registrar, 'AgeNotProven')
        .withArgs(21)
      await registrar.register(e3Id, SLOT, proofParams({ age: 21 }), [])

      const open = await setup({ minAge: 0n })
      await open.registrar.register(open.e3Id, SLOT, proofParams({ age: 3 }), [])
    })

    it('enforces a nationality-in rule against the round’s list', async function () {
      const { registrar, e3Id } = await setup({ nationalityMode: 1, countries: ['DEU', 'FRA'] })
      await expect(registrar.register(e3Id, SLOT, proofParams({ nationality: 'USA' }), ['DEU', 'FRA'])).to.be.revertedWithCustomError(
        registrar,
        'NationalityNotProven',
      )
      await registrar.register(e3Id, SLOT, proofParams({ nationality: 'FRA' }), ['DEU', 'FRA'])
    })

    it('enforces a nationality-out rule against the round’s list', async function () {
      const { registrar, e3Id } = await setup({ nationalityMode: 2, countries: ['PRK', 'IRN'] })
      await expect(registrar.register(e3Id, SLOT, proofParams({ nationality: 'IRN' }), ['PRK', 'IRN'])).to.be.revertedWithCustomError(
        registrar,
        'NationalityNotProven',
      )
      await registrar.register(e3Id, SLOT, proofParams({ nationality: 'DEU' }), ['PRK', 'IRN'])
    })

    it('refuses a country list other than the one the round was created with', async function () {
      const { registrar, e3Id } = await setup({ nationalityMode: 1, countries: ['DEU', 'FRA'] })
      for (const list of [['DEU'], ['FRA', 'DEU'], ['DEU', 'FRA', 'USA'], []]) {
        await expect(registrar.register(e3Id, SLOT, proofParams({ nationality: 'USA' }), list)).to.be.revertedWithCustomError(
          registrar,
          'CountriesMismatch',
        )
      }
      // a round with no rule takes no list
      const open = await setup()
      await expect(open.registrar.register(open.e3Id, SLOT, proofParams(), ['DEU'])).to.be.revertedWithCustomError(
        open.registrar,
        'CountriesMismatch',
      )
    })

    it('uses the round’s mock-document setting', async function () {
      const { registrar, verifier, e3Id } = await setup({ allowMockDocuments: false })
      await registrar.register(e3Id, SLOT, proofParams(), [])
      expect((await verifier.lastServiceConfig()).devMode).to.equal(false)
    })

    it('closes with the input window', async function () {
      const { registrar, e3Id, inputWindow } = await setup()
      await increaseTimeTo(inputWindow[1] - 2)
      await registrar.register(e3Id, SLOT, proofParams(), [])
      await increaseTimeTo(inputWindow[1])
      await expect(registrar.register(e3Id, OTHER_SLOT, proofParams({ slot: OTHER_SLOT, document: ethers.id('d2') }), []))
        .to.be.revertedWithCustomError(registrar, 'RegistrationClosed')
        .withArgs(e3Id)
    })

    it('only registers rounds that name it', async function () {
      const f = await deployFixture()
      const a = await deployRegistrar(f)
      const b = await deployRegistrar(f)
      const own = await request(f, customParams({ registrar: await a.registrar.getAddress() }))
      const aztecPath = await request(f, customParams())

      // another registrar's round, a round registered on Aztec, and an unknown round
      await expect(b.registrar.register(own.e3Id, SLOT, proofParams(), [])).to.be.revertedWithCustomError(b.registrar, 'NotRoundRegistrar')
      await expect(a.registrar.register(aztecPath.e3Id, SLOT, proofParams(), [])).to.be.revertedWithCustomError(
        a.registrar,
        'NotRoundRegistrar',
      )
      await expect(a.registrar.register(12345, SLOT, proofParams(), [])).to.be.revertedWithCustomError(a.registrar, 'NotRoundRegistrar')
    })
  })

  describe('registerMember', function () {
    it('is callable only by the round’s registrar', async function () {
      const { f, e3Id } = await setup()
      const [owner] = await ethers.getSigners()
      await expect(f.program.connect(owner).registerMember(e3Id, SLOT)).to.be.revertedWithCustomError(f.program, 'CallerNotRegistrar')

      // a round registered on Aztec has no registrar at all, and neither does an unknown round
      const aztecPath = await request(f, customParams())
      await expect(f.program.connect(owner).registerMember(aztecPath.e3Id, SLOT)).to.be.revertedWithCustomError(
        f.program,
        'CallerNotRegistrar',
      )
      await expect(f.program.connect(owner).registerMember(99, SLOT)).to.be.revertedWithCustomError(f.program, 'CallerNotRegistrar')
    })
  })
})
