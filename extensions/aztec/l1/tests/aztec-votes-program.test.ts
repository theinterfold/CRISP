// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { expect } from 'chai'
import { abiCoder, defaultWindow, deployFixture, ethers, increaseTimeTo, latestTimestamp, sha256ToField } from './utils'

type VotesFixture = Awaited<ReturnType<typeof deployFixture>>

const CUSTOM = 1
const ONCHAIN = 2
/** `MockInterfold.PLAINTEXT_MODULUS`. */
const T = 17_000_000n

interface Params {
  token: string
  minVotingPower?: bigint
  numOptions?: bigint
  creditMode?: number
  credits?: bigint
  censusMode?: number
  requestedDivisor?: bigint
}

/** `CRISPProgram`'s 7-field `customParams`. */
function votesParams(p: Params): string {
  const { token, minVotingPower = 1_000n, numOptions = 3n, creditMode = CUSTOM, credits = 0n, censusMode = ONCHAIN, requestedDivisor = 0n } = p
  return abiCoder.encode(
    ['address', 'uint256', 'uint256', 'uint8', 'uint256', 'uint256', 'uint256'],
    [token, minVotingPower, numOptions, creditMode, credits, censusMode, requestedDivisor],
  )
}

async function request(f: VotesFixture, params: string, window?: [number, number]) {
  const inputWindow = window ?? (await defaultWindow())
  const program = await f.program.getAddress()
  const e3Id = BigInt(await f.interfold.request.staticCall(program, inputWindow, params))
  const receipt = await (await f.interfold.request(program, inputWindow, params)).wait()
  return { e3Id, inputWindow, receipt }
}

/** A token with balances delegated to their holders, mined before the next request. */
async function tokenWith(balances: Record<string, bigint>, name = 'MockVotesToken'): Promise<any> {
  const token: any = await ethers.deployContract(name)
  for (const [holder, amount] of Object.entries(balances)) {
    await (await token.mint(holder, amount)).wait()
    const signer = await ethers.getSigner(holder)
    await (await token.connect(signer).delegate(holder)).wait()
  }
  return token
}

function inboxMessages(f: VotesFixture, receipt: any) {
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

describe('CRISPAztecVotesProgram', function () {
  let f: VotesFixture
  let alice: string
  let bob: string
  let carol: string

  beforeEach(async function () {
    f = await deployFixture({ contract: 'CRISPAztecVotesProgram' })
    ;[, { address: alice }, { address: bob }, { address: carol }] = await ethers.getSigners()
  })

  describe('customParams', function () {
    it('accepts CUSTOM credits 0 with the ONCHAIN census, and reports no availability window', async function () {
      const token = await tokenWith({ [alice]: 1_000_000n, [bob]: 500_000n })
      await request(f, votesParams({ token: await token.getAddress() }))

      expect(await f.program.availabilityFinalizationWindow()).to.equal(0n)
    })

    it('refuses every other credit mode, credits and census mode', async function () {
      const token = await (await tokenWith({ [alice]: 1_000_000n })).getAddress()
      const refused = (p: Partial<Params>, error: string) =>
        expect(f.interfold.request(f.program.target, [0, 0], votesParams({ token, ...p }))).to.be.revertedWithCustomError(f.program, error)

      await refused({ creditMode: 0, credits: 10n }, 'UnsupportedCreditMode')
      await refused({ credits: 10n }, 'UnsupportedCredits')
      await refused({ censusMode: 0 }, 'UnsupportedCensusMode')
      await refused({ censusMode: 1 }, 'UnsupportedCensusMode')
      await refused({ censusMode: 3 }, 'UnsupportedCensusMode')
    })

    it('refuses option counts outside 2..MAX_VOTE_OPTIONS', async function () {
      const token = await (await tokenWith({ [alice]: 1_000_000n })).getAddress()
      for (const numOptions of [0n, 1n, 11n]) {
        await expect(f.interfold.request(f.program.target, [0, 0], votesParams({ token, numOptions }))).to.be.revertedWithCustomError(
          f.program,
          'InvalidNumOptions',
        )
      }
      await request(f, votesParams({ token, numOptions: 10n }))
    })

    it('refuses an address that is not a votes token', async function () {
      for (const token of [alice, await f.dataAvailability.getAddress()]) {
        await expect(f.interfold.request(f.program.target, [0, 0], votesParams({ token }))).to.be.revertedWithCustomError(
          f.program,
          'CensusModeRequiresToken',
        )
      }
    })
  })

  describe('snapshot, divisor and floor', function () {
    it('uses clock() - 1 of a block-number token and supply / t + 1 as the divisor', async function () {
      const supply = 5n * T + 123n
      const token = await tokenWith({ [alice]: supply })
      const { e3Id, receipt } = await request(f, votesParams({ token: await token.getAddress(), minVotingPower: 6n }))

      expect(await f.program.snapshotOf(e3Id)).to.equal(receipt.blockNumber - 1)
      expect(await f.program.votingPowerDivisorOf(e3Id)).to.equal(supply / T + 1n)
    })

    it('reads the snapshot in the token clock units (ERC-6372 timestamp)', async function () {
      const token = await tokenWith({ [alice]: 10n * T }, 'MockTimestampVotesToken')
      const { e3Id, receipt } = await request(f, votesParams({ token: await token.getAddress(), minVotingPower: 11n }))
      const block = await ethers.provider.getBlock(receipt.blockNumber)

      expect(await f.program.snapshotOf(e3Id)).to.equal(block!.timestamp - 1)
      expect(await f.program.votingPowerDivisorOf(e3Id)).to.equal(11n)
    })

    it('honours a larger requested divisor and refuses one below the minimum', async function () {
      const token = await (await tokenWith({ [alice]: 5n * T })).getAddress()
      const { e3Id } = await request(f, votesParams({ token, minVotingPower: 100n, requestedDivisor: 100n }))
      expect(await f.program.votingPowerDivisorOf(e3Id)).to.equal(100n)

      await expect(
        f.interfold.request(f.program.target, [0, 0], votesParams({ token, requestedDivisor: 5n })),
      ).to.be.revertedWithCustomError(f.program, 'VotingPowerDivisorBelowMinimum')
    })

    it('refuses a floor below the divisor', async function () {
      const token = await (await tokenWith({ [alice]: 5n * T })).getAddress()
      await expect(f.interfold.request(f.program.target, [0, 0], votesParams({ token, minVotingPower: 5n }))).to.be.revertedWithCustomError(
        f.program,
        'MinVotingPowerBelowScale',
      )
      await request(f, votesParams({ token, minVotingPower: 6n }))
    })

    it('weighs a slot at snapshot power over the divisor, zero below the floor', async function () {
      const token = await tokenWith({ [alice]: 10n * T, [bob]: 1_000_000n })
      const { e3Id } = await request(f, votesParams({ token: await token.getAddress(), minVotingPower: 2_000_000n }))
      const divisor = await f.program.votingPowerDivisorOf(e3Id)

      expect(await f.program.weightOf(e3Id, alice)).to.equal((10n * T) / divisor)
      expect(await f.program.weightOf(e3Id, bob)).to.equal(0n)
      expect(await f.program.weightOf(e3Id, carol)).to.equal(0n)

      // Power gained after the snapshot does not count.
      await (await token.mint(bob, 10n * T)).wait()
      await (await token.connect(await ethers.getSigner(bob)).delegate(bob)).wait()
      expect(await f.program.weightOf(e3Id, bob)).to.equal(0n)
    })
  })

  describe('ROUND message', function () {
    it('sends the 6-word votes layout through the Inbox', async function () {
      const token = await tokenWith({ [alice]: 1_000_000n })
      const { e3Id, inputWindow, receipt } = await request(f, votesParams({ token: await token.getAddress(), numOptions: 4n }))
      const message = abiCoder.encode(
        ['uint256', 'uint256', 'uint256', 'uint256', 'uint256', 'uint256'],
        [1n, BigInt.asUintN(96, e3Id), 4n, inputWindow[0], inputWindow[1], 65_536n],
      )

      const events = await f.program.queryFilter(f.program.filters.RoundConfigSent(e3Id), receipt.blockNumber, receipt.blockNumber)
      expect(events[0].args.content).to.equal(sha256ToField(message))
      expect(inboxMessages(f, receipt)).to.have.length(1)
    })
  })

  describe('enroll', function () {
    let e3Id: bigint
    let inputWindow: [number, number]
    let token: any

    beforeEach(async function () {
      token = await tokenWith({ [alice]: 10n * T, [bob]: 20n * T, [carol]: 100n })
      ;({ e3Id, inputWindow } = await request(f, votesParams({ token: await token.getAddress(), minVotingPower: 1_000_000n })))
    })

    it('lets anyone send the ENROLL message of each eligible slot and reports its Inbox leaf', async function () {
      const [, , , , stranger] = await ethers.getSigners()
      const receipt = await (await f.program.connect(stranger).enroll(e3Id, [alice, bob])).wait()
      const inBlock = [receipt.blockNumber, receipt.blockNumber] as const
      const events = await f.program.queryFilter(f.program.filters.Enrolled(e3Id), ...inBlock)
      const sent = await f.program.queryFilter(f.program.filters.L1ToL2MessageSent(e3Id), ...inBlock)
      expect(events).to.have.length(2)

      const inbox = inboxMessages(f, receipt)
      for (const [i, slot] of [alice, bob].entries()) {
        const weight = await f.program.weightOf(e3Id, slot)
        const content = sha256ToField(
          abiCoder.encode(
            ['uint256', 'uint256', 'uint256', 'uint256'],
            [4n, BigInt.asUintN(96, e3Id), BigInt(slot), weight],
          ),
        )
        expect(events[i].args.slot).to.equal(slot)
        expect(events[i].args.weight).to.equal(weight)
        expect(inbox[i].args.message.content).to.equal(content)
        expect(sent[i].args.content).to.equal(content)
        expect(events[i].args.leaf).to.equal(sent[i].args.leaf)
        expect(await f.program.isEnrolled(e3Id, slot)).to.equal(true)
      }
    })

    it('returns how many slots it sent and skips enrolled and below-floor slots without reverting', async function () {
      expect(await f.program.enroll.staticCall(e3Id, [alice, carol, alice, bob])).to.equal(2n)
      await (await f.program.enroll(e3Id, [alice])).wait()

      const receipt = await (await f.program.enroll(e3Id, [alice, carol, bob])).wait()
      const events = await f.program.queryFilter(f.program.filters.Enrolled(e3Id), receipt.blockNumber, receipt.blockNumber)
      expect(events.map((e: any) => e.args.slot)).to.deep.equal([bob])
      expect(await f.program.isEnrolled(e3Id, carol)).to.equal(false)
      expect(await f.program.enroll.staticCall(e3Id, [alice, bob, carol])).to.equal(0n)
    })

    it('refuses an unknown E3 and an enrolment after the input window ended', async function () {
      await expect(f.program.enroll(e3Id + 1n, [alice])).to.be.revertedWithCustomError(f.program, 'E3NotAssignedToProgram')

      await increaseTimeTo(inputWindow[1])
      expect(await latestTimestamp()).to.be.gte(inputWindow[1])
      await expect(f.program.enroll(e3Id, [alice])).to.be.revertedWithCustomError(f.program, 'InputWindowClosed')
    })
  })
})
