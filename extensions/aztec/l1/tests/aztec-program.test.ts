// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { readFileSync } from 'node:fs'
import { expect } from 'chai'
import {
  abiCoder,
  customParams,
  defaultWindow,
  deployFixture,
  ethers,
  FIELD_MODULUS,
  l1ToL2Leaf,
  l2ToL1Leaf,
  latestTimestamp,
  outboxTree,
  ROLLUP_VERSION,
  sha256ToField,
  STAGE,
} from './utils'

const vectors = JSON.parse(readFileSync(new URL('./fixtures/message-vectors.json', import.meta.url), 'utf8'))
const INPUT_ROOT = vectors.root.fields.inputRoot as string
const COMMITTEE_KEY = vectors.key.fields.committeePublicKey as string

async function request(f: Awaited<ReturnType<typeof deployFixture>>, params = customParams(), window?: [number, number]) {
  const inputWindow = window ?? (await defaultWindow())
  const e3Id = await f.interfold.request.staticCall(await f.program.getAddress(), inputWindow, params)
  const tx = await f.interfold.request(await f.program.getAddress(), inputWindow, params)
  return { e3Id: BigInt(e3Id), inputWindow, tx, receipt: await tx.wait() }
}

/** The id the remote chain knows an E3 by: the low 96 bits (`CRISPRemoteProgram.remoteRoundId`). */
const roundIdOf = (e3Id: bigint) => BigInt.asUintN(96, e3Id)

/** `uint160(interfold) << 96 | roundId`: what Interfold issues. */
async function e3IdOf(f: Awaited<ReturnType<typeof deployFixture>>, roundId: bigint) {
  return (BigInt(await f.interfold.getAddress()) << 96n) | roundId
}

/** Request rounds until the one with round id `target` exists; the vectors are written for round id 7. */
async function requestUntil(f: Awaited<ReturnType<typeof deployFixture>>, target: bigint) {
  let id: bigint
  do id = (await request(f)).e3Id
  while (roundIdOf(id) < target)
  return id
}

/** The one `MessageSent` event the real Inbox emitted in `receipt`, decoded. */
function inboxMessages(f: Awaited<ReturnType<typeof deployFixture>>, receipt: any) {
  return receipt.logs
    .map((log: any) => {
      try {
        return f.inbox.interface.parseLog(log)
      } catch {
        return null
      }
    })
    .filter((parsed: any) => parsed?.name === 'MessageSent')
}

async function toKeyPublished(f: Awaited<ReturnType<typeof deployFixture>>, e3Id: bigint) {
  await (await f.interfold.setCommitteePublicKey(e3Id, COMMITTEE_KEY)).wait()
  await (await f.interfold.setStage(e3Id, STAGE.KeyPublished)).wait()
}

describe('CRISPAztecProgram', function () {
  describe('deployment and wiring', function () {
    it('takes the rollup version only when both bridge contracts report it', async function () {
      const f = await deployFixture()
      const [owner] = await ethers.getSigners()
      const imageId = await f.receiptVerifier.imageId()
      const deploy = (inbox: string, outbox: string, version: bigint) =>
        ethers.deployContract('CRISPAztecProgram', [
          owner.address,
          f.receiptVerifier.target,
          imageId,
          f.dataAvailability.target,
          0n,
          0n,
          inbox,
          outbox,
          version,
        ])

      await expect(deploy(await f.inbox.getAddress(), await f.outbox.getAddress(), ROLLUP_VERSION + 1n)).to.be.revertedWithCustomError(
        f.program,
        'RollupVersionMismatch',
      )
      await expect(deploy(ethers.ZeroAddress, await f.outbox.getAddress(), ROLLUP_VERSION)).to.be.revertedWithCustomError(
        f.program,
        'InboxAddressZero',
      )
      await expect(deploy(await f.inbox.getAddress(), ethers.ZeroAddress, ROLLUP_VERSION)).to.be.revertedWithCustomError(
        f.program,
        'OutboxAddressZero',
      )
      expect(await f.program.rollupVersion()).to.equal(ROLLUP_VERSION)
    })

    it('refuses an image id the receipt verifier does not accept and a sub-hour minimum voting window', async function () {
      const f = await deployFixture()
      const [owner] = await ethers.getSigners()
      const deploy = (imageId: string, minVotingDuration: bigint) =>
        ethers.deployContract('CRISPAztecProgram', [
          owner.address,
          f.receiptVerifier.target,
          imageId,
          f.dataAvailability.target,
          minVotingDuration,
          0n,
          f.inbox.target,
          f.outbox.target,
          ROLLUP_VERSION,
        ])
      await expect(deploy(ethers.ZeroHash, 0n)).to.be.revertedWithCustomError(f.program, 'InvalidImageId')
      await expect(deploy(await f.receiptVerifier.imageId(), 59n * 60n)).to.be.revertedWithCustomError(
        f.program,
        'InvalidMinVotingDuration',
      )
    })

    it('binds Interfold once, only after it registered the program', async function () {
      const f = await deployFixture({ bind: false })
      const [, other] = await ethers.getSigners()
      const interfoldAddress = await f.interfold.getAddress()
      await expect(f.program.connect(other).bindInterfold(interfoldAddress)).to.be.revertedWithCustomError(
        f.program,
        'OwnableUnauthorizedAccount',
      )
      await expect(f.program.bindInterfold(ethers.ZeroAddress)).to.be.revertedWithCustomError(f.program, 'InterfoldAddressZero')
      await expect(f.program.bindInterfold(other.address)).to.be.revertedWithCustomError(f.program, 'InterfoldNotContract')
      const unregistered = await ethers.deployContract('MockInterfold')
      await expect(f.program.bindInterfold(await unregistered.getAddress())).to.be.revertedWithCustomError(
        f.program,
        'ProgramNotRegistered',
      )

      await expect(f.program.bindInterfold(interfoldAddress)).to.emit(f.program, 'InterfoldBound').withArgs(interfoldAddress)
      await expect(f.program.bindInterfold(interfoldAddress)).to.be.revertedWithCustomError(f.program, 'InterfoldAlreadyBound')
    })

    it('sets the L2 program once, only by the owner, only to a field element', async function () {
      const f = await deployFixture({ setL2Program: false })
      const [, other] = await ethers.getSigners()
      await expect(f.program.connect(other).setL2Program(f.l2Program)).to.be.revertedWithCustomError(
        f.program,
        'OwnableUnauthorizedAccount',
      )
      await expect(f.program.setL2Program(ethers.ZeroHash)).to.be.revertedWithCustomError(f.program, 'InvalidL2Program')
      await expect(f.program.setL2Program(ethers.zeroPadValue(ethers.toBeHex(FIELD_MODULUS), 32))).to.be.revertedWithCustomError(
        f.program,
        'InvalidL2Program',
      )
      await expect(f.program.setL2Program(f.l2Program)).to.emit(f.program, 'L2ProgramSet').withArgs(f.l2Program)
      await expect(f.program.setL2Program(f.l2Program)).to.be.revertedWithCustomError(f.program, 'L2ProgramAlreadySet')
    })

    it('cannot open a round before the L2 program is known', async function () {
      const f = await deployFixture({ setL2Program: false })
      await expect(request(f)).to.be.revertedWithCustomError(f.program, 'L2ProgramNotSet')
    })

    it('advertises the E3 program interfaces Interfold probes', async function () {
      const { program } = await deployFixture()
      expect(await program.supportsInterface('0x01ffc9a7')).to.equal(true)
      expect(await program.supportsInterface('0xffffffff')).to.equal(false)
      // IE3Program and IE3ProgramDataAvailability, computed from their selectors.
      const xor = (sigs: string[]) =>
        '0x' +
        sigs
          .map((sig) => BigInt(ethers.id(sig).slice(0, 10)))
          .reduce((a, b) => a ^ b)
          .toString(16)
          .padStart(8, '0')
      expect(
        await program.supportsInterface(
          xor(['validate(uint256,uint256,bytes,bytes,bytes)', 'verify(uint256,bytes32,bytes32,bytes)', 'publishInput(uint256,bytes)']),
        ),
      ).to.equal(true)
      expect(await program.supportsInterface(xor(['verifyDataAvailability(bytes32,bytes)']))).to.equal(true)
    })
  })

  describe('validate (ROUND message)', function () {
    it('sends the round configuration through the real Aztec Inbox', async function () {
      const f = await deployFixture()
      const chainId = (await ethers.provider.getNetwork()).chainId
      const { e3Id, inputWindow, tx, receipt } = await request(f)

      const [message] = inboxMessages(f, receipt)
      const sent = message.args.message
      const scopeHash = await f.program.scopeHashOf(e3Id)
      const expectedBytes = abiCoder.encode(Array(10).fill('uint256'), [
        1,
        roundIdOf(e3Id),
        3,
        100,
        inputWindow[0],
        inputWindow[1],
        65536,
        scopeHash,
        18,
        1,
      ])
      const expectedContent = sha256ToField(expectedBytes)

      expect(sent.sender.actor).to.equal(await f.program.getAddress())
      expect(sent.sender.chainId).to.equal(chainId)
      expect(sent.recipient.actor).to.equal(f.l2Program)
      expect(sent.recipient.version).to.equal(ROLLUP_VERSION)
      expect(sent.content).to.equal(expectedContent)
      expect(sent.secretHash).to.equal(await f.program.SECRET_HASH())
      // The leaf the L2 contract consumes is what the Inbox computed, and what an independent encoder computes.
      expect(message.args.hash).to.equal(l1ToL2Leaf(sent))

      await expect(tx).to.emit(f.program, 'RoundConfigSent').withArgs(e3Id, expectedContent)
      await expect(tx).to.emit(f.program, 'L1ToL2MessageSent').withArgs(e3Id, expectedContent, message.args.hash, sent.index)

      const round = await f.program.getRound(e3Id)
      expect(round.numOptions).to.equal(3n)
      expect(round.inputLimit).to.equal(65536n)
      expect(round.paramsHash).to.equal(ethers.keccak256(await f.interfold.e3ProgramParams()))
      expect(await f.program.getParamsHash(e3Id)).to.equal(round.paramsHash)
    })

    it('caps the input limit at 65_536 and derives it from credits otherwise', async function () {
      const f = await deployFixture()
      // (17_000_000 - 1) / 1000 = 16_999 ballots keep every option total below the plaintext modulus.
      const limited = await request(f, customParams({ credits: 1000n }))
      expect((await f.program.getRound(limited.e3Id)).inputLimit).to.equal(16_999n)
      // The remote contract is told the same limit.
      const [message] = inboxMessages(f, limited.receipt)
      const scopeHash = await f.program.scopeHashOf(limited.e3Id)
      const bytes = abiCoder.encode(Array(10).fill('uint256'), [
        1,
        roundIdOf(limited.e3Id),
        3,
        1000,
        limited.inputWindow[0],
        limited.inputWindow[1],
        16_999,
        scopeHash,
        18,
        1,
      ])
      expect(message.args.message.content).to.equal(sha256ToField(bytes))

      const zeroCredits = await request(f, customParams({ credits: 0n }))
      expect((await f.program.getRound(zeroCredits.e3Id)).inputLimit).to.equal(65536n)
      const huge = await request(f, customParams({ credits: 1n }))
      expect((await f.program.getRound(huge.e3Id)).inputLimit).to.equal(65536n)
    })

    it('refuses configurations the circuit or the plaintext modulus cannot serve', async function () {
      const f = await deployFixture()
      await expect(request(f, customParams({ numOptions: 1n }))).to.be.revertedWithCustomError(f.program, 'InvalidNumOptions')
      await expect(request(f, customParams({ numOptions: 11n }))).to.be.revertedWithCustomError(f.program, 'InvalidNumOptions')
      await expect(request(f, customParams({ minAge: 100n }))).to.be.revertedWithCustomError(f.program, 'InvalidMinAge')
      await request(f, customParams({ minAge: 99n }))
      await expect(request(f, customParams({ credits: 17_000_000n }))).to.be.revertedWithCustomError(
        f.program,
        'CreditsExceedPlaintextModulus',
      )
      await expect(request(f, '0x')).to.be.revert(ethers)
    })

    it('can only be called by the bound Interfold', async function () {
      const f = await deployFixture()
      const [owner] = await ethers.getSigners()
      await expect(
        f.program.connect(owner).validate(0, 0, await f.interfold.e3ProgramParams(), '0x', customParams()),
      ).to.be.revertedWithCustomError(f.program, 'CallerNotAuthorized')
    })

    it('keys a round by the low 96 bits of an e3Id that does not fit a field element', async function () {
      const f = await deployFixture()
      const { e3Id } = await request(f)
      // Interfold issues uint160(interfold) << 96 | sequence: far above the BN254 modulus, so only the sequence travels.
      expect(e3Id).to.be.greaterThan(FIELD_MODULUS)
      expect(await f.program.remoteRoundId(e3Id)).to.equal(roundIdOf(e3Id))
      expect(roundIdOf(e3Id)).to.equal(0n)
      expect(await f.program.e3IdOf(roundIdOf(e3Id))).to.equal(e3Id)
      const next = (await request(f)).e3Id
      expect(await f.program.remoteRoundId(next)).to.equal(1n)
      expect(await f.program.e3IdOf(1n)).to.equal(next)
      await expect(f.program.e3IdOf(2n ** 96n + 1n))
        .to.be.revertedWithCustomError(f.program, 'InvalidRoundId')
        .withArgs(2n ** 96n + 1n)
    })

    it('refuses an e3Id the bound Interfold did not issue', async function () {
      const f = await deployFixture()
      // Another Interfold's high bits would collide with this one's sequence on the remote chain.
      await (await f.interfold.setNextE3Id(5n)).wait()
      await expect(request(f)).to.be.revertedWithCustomError(f.program, 'E3NotOfBoundInterfold').withArgs(5n)
      await (await f.interfold.setNextE3Id((BigInt(ethers.hexlify(ethers.randomBytes(20))) << 96n) | 5n)).wait()
      await expect(request(f)).to.be.revertedWithCustomError(f.program, 'E3NotOfBoundInterfold')
    })

    it('enforces the voting timing of CRISPProgram without its availability tail', async function () {
      const f = await deployFixture({ minVotingDuration: 3600n })
      await (await f.interfold.setCommitteeSetupWindows(100, 200, 300)).wait()
      const now = await latestTimestamp()

      // The key can arrive up to 600 s after the request: a start before that is refused.
      await expect(request(f, customParams(), [now + 300, now + 300 + 3600])).to.be.revertedWithCustomError(
        f.program,
        'VotingStartsBeforeKeyDeadline',
      )
      // Voting must last an hour.
      await expect(request(f, customParams(), [now + 1000, now + 1000 + 3599])).to.be.revertedWithCustomError(
        f.program,
        'VotingWindowTooShort',
      )
      await request(f, customParams(), [now + 1000, now + 1000 + 3600])
    })
  })

  describe('remote finality window', function () {
    it('refuses a round whose compute window cannot cover remote finality', async function () {
      const f = await deployFixture({ remoteFinalityWindow: 1000n })
      expect(await f.program.remoteFinalityWindow()).to.equal(1000n)
      await (await f.interfold.setComputeWindow(999)).wait()
      await expect(request(f))
        .to.be.revertedWithCustomError(f.program, 'ComputeWindowTooShort')
        .withArgs(await e3IdOf(f, 0n), 999, 1000)
      await (await f.interfold.setComputeWindow(1000)).wait()
      await request(f)
    })

    it('applies independently of the voting-duration switch and is off at zero', async function () {
      const strict = await deployFixture({ minVotingDuration: 3600n, remoteFinalityWindow: 1000n })
      await (await strict.interfold.setComputeWindow(10)).wait()
      const now = await latestTimestamp()
      await expect(request(strict, customParams(), [now + 600, now + 600 + 3600])).to.be.revertedWithCustomError(
        strict.program,
        'ComputeWindowTooShort',
      )

      const off = await deployFixture()
      await (await off.interfold.setComputeWindow(0)).wait()
      await request(off)
    })
  })

  describe('publishCommitteeKey (KEY message)', function () {
    it('relays the key Interfold published, once', async function () {
      const f = await deployFixture()
      const { e3Id } = await request(f)
      const [, other] = await ethers.getSigners()

      await expect(f.program.publishCommitteeKey(e3Id)).to.be.revertedWithCustomError(f.program, 'KeyNotPublished')
      await toKeyPublished(f, e3Id)

      // Permissionless.
      const tx = await f.program.connect(other).publishCommitteeKey(e3Id)
      const receipt = await tx.wait()
      const [message] = inboxMessages(f, receipt)
      expect(message.args.message.content).to.equal(
        sha256ToField(abiCoder.encode(['uint256', 'uint256', 'bytes32'], [2, roundIdOf(e3Id), COMMITTEE_KEY])),
      )
      expect(message.args.message.recipient.actor).to.equal(f.l2Program)
      expect(message.args.message.secretHash).to.equal(await f.program.SECRET_HASH())
      await expect(tx).to.emit(f.program, 'CommitteeKeyRelayed').withArgs(e3Id, COMMITTEE_KEY)
      expect((await f.program.getRound(e3Id)).keyRelayed).to.equal(true)

      await expect(f.program.publishCommitteeKey(e3Id)).to.be.revertedWithCustomError(f.program, 'CommitteeKeyAlreadyRelayed')
    })

    it('matches the KEY vector for round id 7', async function () {
      const f = await deployFixture()
      const e3Id = await requestUntil(f, 7n)
      await toKeyPublished(f, e3Id)
      const receipt = await (await f.program.publishCommitteeKey(e3Id)).wait()
      expect(inboxMessages(f, receipt)[0].args.message.content).to.equal(vectors.key.content)
    })

    it('refuses an unknown E3 and a round past the key stage', async function () {
      const f = await deployFixture()
      await expect(f.program.publishCommitteeKey(await e3IdOf(f, 99n))).to.be.revertedWithCustomError(f.program, 'E3NotAssignedToProgram')
      const { e3Id } = await request(f)
      await toKeyPublished(f, e3Id)
      await (await f.interfold.setStage(e3Id, STAGE.CiphertextReady)).wait()
      await expect(f.program.publishCommitteeKey(e3Id)).to.be.revertedWithCustomError(f.program, 'KeyNotPublished')
    })
  })

  describe('submitInputRoot (ROOT message, real Outbox)', function () {
    /** The ROOT message the L2 contract would emit, included in an epoch tree the "rollup" inserts into the real Outbox. */
    async function closeOnL2(f: Awaited<ReturnType<typeof deployFixture>>, e3Id: bigint, root = INPUT_ROOT, numInputs = 5n, epoch = 3n) {
      const chainId = (await ethers.provider.getNetwork()).chainId
      const content = sha256ToField(abiCoder.encode(['uint256', 'uint256', 'uint256', 'uint256'], [3, roundIdOf(e3Id), root, numInputs]))
      const leaf = l2ToL1Leaf(f.l2Program, ROLLUP_VERSION, await f.program.getAddress(), chainId, content)
      const other = sha256ToField('0x1234')
      const tree = outboxTree([other, leaf, other, other])
      await (await f.outbox.connect(f.rollup).insert(epoch, 4, tree.root)).wait()
      return { epoch, numCheckpoints: 4n, leafIndex: 1n, path: tree.path(1), root, numInputs, e3Id }
    }
    const submit = (f: Awaited<ReturnType<typeof deployFixture>>, w: Awaited<ReturnType<typeof closeOnL2>>, caller?: any) =>
      (caller ? f.program.connect(caller) : f.program).submitInputRoot(
        w.e3Id,
        w.root,
        w.numInputs,
        w.epoch,
        w.numCheckpoints,
        w.leafIndex,
        w.path,
      )

    it('consumes the message, records the root, and lets anyone submit it', async function () {
      const f = await deployFixture()
      const { e3Id } = await request(f)
      await toKeyPublished(f, e3Id)
      const w = await closeOnL2(f, e3Id)
      const [, , stranger] = await ethers.getSigners()

      await expect(submit(f, w, stranger))
        .to.emit(f.program, 'InputRootSubmitted')
        .withArgs(e3Id, INPUT_ROOT, 5n)
        .and.to.emit(f.outbox, 'MessageConsumed')
      const round = await f.program.getRound(e3Id)
      expect(round.rootSubmitted).to.equal(true)
      expect(round.inputRoot).to.equal(BigInt(INPUT_ROOT))
      expect(round.numInputs).to.equal(5n)
    })

    it('cannot consume a message twice', async function () {
      const f = await deployFixture()
      const { e3Id } = await request(f)
      await toKeyPublished(f, e3Id)
      const w = await closeOnL2(f, e3Id)
      await (await submit(f, w)).wait()
      await expect(submit(f, w)).to.be.revertedWithCustomError(f.outbox, 'Outbox__AlreadyNullified')
    })

    it('rejects a root or count the L2 did not send', async function () {
      const f = await deployFixture()
      const { e3Id } = await request(f)
      await toKeyPublished(f, e3Id)
      const w = await closeOnL2(f, e3Id)
      await expect(submit(f, { ...w, root: ethers.toBeHex(BigInt(INPUT_ROOT) + 1n, 32) })).to.be.revertedWithCustomError(
        f.outbox,
        'MerkleLib__InvalidRoot',
      )
      await expect(submit(f, { ...w, numInputs: 6n })).to.be.revertedWithCustomError(f.outbox, 'MerkleLib__InvalidRoot')
      const second = (await request(f)).e3Id
      await expect(submit(f, { ...w, e3Id: second })).to.be.revertedWithCustomError(f.outbox, 'MerkleLib__InvalidRoot')
    })

    it('rejects a message from any contract other than the L2 program', async function () {
      const f = await deployFixture()
      const { e3Id } = await request(f)
      await toKeyPublished(f, e3Id)
      const chainId = (await ethers.provider.getNetwork()).chainId
      const content = sha256ToField(abiCoder.encode(['uint256', 'uint256', 'uint256', 'uint256'], [3, roundIdOf(e3Id), INPUT_ROOT, 5]))
      const impostor = ethers.zeroPadValue('0x01', 32)
      const leaf = l2ToL1Leaf(impostor, ROLLUP_VERSION, await f.program.getAddress(), chainId, content)
      const tree = outboxTree([leaf, leaf, leaf, leaf])
      await (await f.outbox.connect(f.rollup).insert(5, 1, tree.root)).wait()
      await expect(f.program.submitInputRoot(e3Id, INPUT_ROOT, 5, 5, 1, 0, tree.path(0))).to.be.revertedWithCustomError(
        f.outbox,
        'MerkleLib__InvalidRoot',
      )
    })

    it('refuses a root for a round that already left the key stage, an unknown round, a zero root, and too many inputs', async function () {
      const f = await deployFixture()
      const { e3Id } = await request(f)
      await toKeyPublished(f, e3Id)

      const tooMany = await closeOnL2(f, e3Id, INPUT_ROOT, 65_537n, 4n)
      await expect(submit(f, tooMany)).to.be.revertedWithCustomError(f.program, 'InputCountExceedsLimit')
      const zero = await closeOnL2(f, e3Id, ethers.ZeroHash, 1n, 5n)
      await expect(submit(f, zero)).to.be.revertedWithCustomError(f.program, 'InvalidInputRoot')
      const unknown = await closeOnL2(f, await e3IdOf(f, 77n), INPUT_ROOT, 1n, 6n)
      await expect(submit(f, unknown)).to.be.revertedWithCustomError(f.program, 'E3NotAssignedToProgram')

      const late = await closeOnL2(f, e3Id, INPUT_ROOT, 5n, 7n)
      await (await f.interfold.setStage(e3Id, STAGE.Failed)).wait()
      await expect(submit(f, late)).to.be.revertedWithCustomError(f.program, 'KeyNotPublished')
      // The failed submission rolled the Outbox consumption back, so the message is still usable.
      await (await f.interfold.setStage(e3Id, STAGE.KeyPublished)).wait()
      await submit(f, late)
    })

    it('matches the ROOT vector', async function () {
      const f = await deployFixture()
      const e3Id = await requestUntil(f, 7n)
      await toKeyPublished(f, e3Id)
      const w = await closeOnL2(f, e3Id)
      const content = sha256ToField(abiCoder.encode(['uint256', 'uint256', 'uint256', 'uint256'], [3, 7, INPUT_ROOT, 5]))
      expect(content).to.equal(vectors.root.content)
      await submit(f, w)
    })
  })

  describe('verify', function () {
    async function submitted(numInputs = 5n) {
      const f = await deployFixture()
      const { e3Id } = await request(f)
      await toKeyPublished(f, e3Id)
      const chainId = (await ethers.provider.getNetwork()).chainId
      const content = sha256ToField(abiCoder.encode(['uint256', 'uint256', 'uint256', 'uint256'], [3, roundIdOf(e3Id), INPUT_ROOT, numInputs]))
      const leaf = l2ToL1Leaf(f.l2Program, ROLLUP_VERSION, await f.program.getAddress(), chainId, content)
      const tree = outboxTree([leaf, leaf, leaf, leaf])
      await (await f.outbox.connect(f.rollup).insert(1, 4, tree.root)).wait()
      return { f, e3Id, tree, content, leaf }
    }

    it('checks the OpenVM journal against the root the L2 delivered', async function () {
      const { f, e3Id, tree } = await submitted()
      const paramsHash = ethers.keccak256(await f.interfold.e3ProgramParams())
      const ciphertextOutputHash = ethers.id('output')
      const ciphertextCommitment = ethers.id('commitment')
      const chainId = (await ethers.provider.getNetwork()).chainId
      const encryptionSchemeId = ethers.id('fhe.rs:BFV')
      const word = (v: bigint | string) => ethers.zeroPadValue(typeof v === 'string' ? v : ethers.toBeHex(v), 32)
      const journal = ethers.concat([
        word(chainId),
        word(await f.interfold.getAddress()),
        word(e3Id),
        encryptionSchemeId,
        COMMITTEE_KEY,
        ciphertextOutputHash,
        ciphertextCommitment,
        paramsHash,
        INPUT_ROOT,
      ])
      await (await f.receiptVerifier.setExpectedJournalDigest(ethers.sha256(journal))).wait()
      const proof = abiCoder.encode(['bytes', 'bytes32', 'bytes32'], ['0x1234', paramsHash, INPUT_ROOT])

      // No root yet.
      await expect(f.program.verify(e3Id, ciphertextOutputHash, ciphertextCommitment, proof)).to.be.revertedWithCustomError(
        f.program,
        'InputRootNotSubmitted',
      )

      await (await f.program.submitInputRoot(e3Id, INPUT_ROOT, 5, 1, 4, 0, tree.path(0))).wait()
      expect(await f.program.verify.staticCall(e3Id, ciphertextOutputHash, ciphertextCommitment, proof)).to.equal(true)

      // A proof over another root or params, or another output, is refused.
      const otherRoot = abiCoder.encode(['bytes', 'bytes32', 'bytes32'], ['0x1234', paramsHash, ethers.id('other root')])
      await expect(f.program.verify(e3Id, ciphertextOutputHash, ciphertextCommitment, otherRoot)).to.be.revertedWithCustomError(
        f.program,
        'InvalidComputeContext',
      )
      const otherParams = abiCoder.encode(['bytes', 'bytes32', 'bytes32'], ['0x1234', ethers.id('params'), INPUT_ROOT])
      await expect(f.program.verify(e3Id, ciphertextOutputHash, ciphertextCommitment, otherParams)).to.be.revertedWithCustomError(
        f.program,
        'InvalidComputeContext',
      )
      await expect(f.program.verify(e3Id, ethers.id('other output'), ciphertextCommitment, proof)).to.be.revertedWithCustomError(
        f.receiptVerifier,
        'UnexpectedJournalDigest',
      )
    })
  })

  describe('inputs and outputs', function () {
    it('takes no inputs on L1', async function () {
      const f = await deployFixture()
      const { e3Id } = await request(f)
      await expect(f.program.publishInput(e3Id, '0x')).to.be.revertedWithCustomError(f.program, 'InputsLiveOnRemoteChain')
      await expect(f.program.publishInput(e3Id, '0x1234')).to.be.revertedWithCustomError(f.program, 'InputsLiveOnRemoteChain')
    })

    it('verifies output availability like CRISPProgram', async function () {
      const f = await deployFixture()
      const output = ethers.toUtf8Bytes('aggregate ciphertext')
      const receipt = await f.program.verifyDataAvailability(ethers.keccak256(output), output)
      expect(receipt.contentHash).to.equal(ethers.keccak256(output))
      await expect(f.program.verifyDataAvailability(ethers.id('other'), output)).to.be.revert(ethers)
    })

    it('decodes the tally as little-endian uint64 coefficients', async function () {
      const f = await deployFixture()
      const { e3Id } = await request(f, customParams({ numOptions: 3n }))
      expect(await f.program.decodeTally(999)).to.deep.equal([])
      const output = new Uint8Array(50 * 8)
      new DataView(output.buffer).setBigUint64(0, 11n, true)
      new DataView(output.buffer).setBigUint64(8, 22n, true)
      new DataView(output.buffer).setBigUint64(16, 33n, true)
      await (await f.interfold.setPlaintextOutput(e3Id, output)).wait()
      expect(await f.program.decodeTally(e3Id)).to.deep.equal([11n, 22n, 33n])
      await (await f.interfold.setPlaintextOutput(e3Id, output.slice(0, 399))).wait()
      await expect(f.program.decodeTally(e3Id)).to.be.revertedWithCustomError(f.program, 'InvalidTallyLength')
    })
  })
})
