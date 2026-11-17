// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

// Registers voters on a local network with REAL mock-document ZKPassport proofs: seeds the vendored registry, deploys a
// CrispAztec whose L1 program is an anvil account standing in for CRISPAztecProgram, opens rounds through the real Inbox
// with the real scope hash, and lands `register` (no age), `register_with_age`, `register_with_nationality` (in / not in a list)
// and `register_with_age_and_nationality`.
//
//   tsx src/demo.ts            (AZTEC_NODE_URL, L1_RPC_URL override the local-network defaults)
import {
  CrispAztec,
  SECRET_HASH,
  connectAztec,
  NATIONALITY_MODE,
  deployCrispAztec,
  e3IdOf,
  encodeRoundMessage,
  nationalityCommitment,
  roundContent,
  scopeHashOf,
  scopeOf,
  type AztecSession,
  type L1ToL2Message,
  type RoundConfig,
} from '@crisp-e3/aztec'
import { createAztecNodeDebugClient } from '@aztec-labs/stdlib/interfaces/client'
import { createPublicClient, createWalletClient, getAddress, http, pad, parseAbi, toHex, type Address, type Hex } from 'viem'
import { mnemonicToAccount, privateKeyToAccount } from 'viem/accounts'
import { foundry } from 'viem/chains'

import {
  CIRCUITS_VERSION,
  LOCAL_NETWORK_REGISTRY_ADDRESS,
  chainTime,
  circuitsVersionField,
  connectRegistryContext,
  domainHash,
  generateMockRegistrationProof,
  seedLocalRegistry,
} from './index'

const NODE_URL = process.env.AZTEC_NODE_URL ?? 'http://localhost:8080'
const L1_RPC_URL = process.env.L1_RPC_URL ?? 'http://localhost:8545'
/** Hash of the fold circuit's noir-recursive verification key (`pnpm -C extensions/aztec/sdk fold-vk-hash`); `register` does not use it. */
const FOLD_VK_HASH = 0x18217e9d33082668b29217bbf1f578b0f9b2a499beb010f8a64728d0ae582589n
const DOMAIN = 'crisp-aztec.local'
/** Stands in for the Interfold: the top 20 bytes of every e3Id (`roundId` is the low 96 bits). */
const INTERFOLD = getAddress('0xdFa59d66c173A00643eBE80e172Af5a8Cf244b30')
const VALIDITY_SECONDS = 86_400n

const inboxAbi = parseAbi([
  'function sendL2Message((bytes32 actor, uint256 version) recipient, bytes32 content, bytes32 secretHash) returns (bytes32, uint256)',
])

const log = (message: string) => console.log(`[${new Date().toISOString()}] ${message}`)

const main = async () => {
  const startedAt = Date.now()
  // The L1 side: the sender of the L1→L2 messages is the contract's `l1_program`. An anvil account (index 7: the local
  // network's sequencer publishes from index 0) stands in for CRISPAztecProgram.
  const program = mnemonicToAccount('test test test test test test test test test test test junk', { addressIndex: 7 })
  const l1 = createPublicClient({ chain: foundry, transport: http(L1_RPC_URL) })
  const l1Wallet = createWalletClient({ account: program, chain: foundry, transport: http(L1_RPC_URL) })

  // ---- Registry: deploy at the canonical address and seed with the mock roots; warps the clock 24 hours ----
  const registryContext = await connectRegistryContext(NODE_URL)
  const seeded = await seedLocalRegistry(registryContext)
  log(`registry ${LOCAL_NETWORK_REGISTRY_ADDRESS}: ${seeded.transactions.length} seeding txs ${JSON.stringify(seeded.transactions)}; readable from ${seeded.readyAt}`)
  await registryContext.stop()

  // ---- CrispAztec ----
  const deployer = await connectAztec(NODE_URL)
  const signer = privateKeyToAccount(`0x${'11'.repeat(32)}`)
  const crisp = await deployCrispAztec(deployer, {
    l1Program: program.address,
    interfold: INTERFOLD,
    domainSeparator: pad('0x01', { size: 32 }),
    availabilitySignerPublicKey: signer.publicKey,
    foldVkHash: FOLD_VK_HASH,
    zkpassportDomainHash: domainHash(DOMAIN),
    zkpassportCircuitVersion: circuitsVersionField(CIRCUITS_VERSION),
    zkpassportValiditySeconds: VALIDITY_SECONDS,
    zkpassportRegistry: LOCAL_NETWORK_REGISTRY_ADDRESS,
  })
  log(`CrispAztec ${crisp.address} (l1Program ${program.address}, rollup version ${deployer.rollupVersion})`)

  const info = await deployer.node.getNodeInfo()
  const inbox = getAddress(info.l1ContractAddresses.inboxAddress.toString()) as Address
  const debug = createAztecNodeDebugClient(NODE_URL)

  /** The ROUND message `Interfold.request` would send, through the real Inbox; then a block so the message is included. */
  const sendRound = async (config: RoundConfig): Promise<L1ToL2Message> => {
    const content = toHex(roundContent(config), { size: 32 })
    const args = [{ actor: crisp.address.toString() as Hex, version: BigInt(deployer.rollupVersion) }, content, SECRET_HASH] as const
    const { result, request } = await l1.simulateContract({ address: inbox, abi: inboxAbi, functionName: 'sendL2Message', args, account: program })
    const hash = await l1Wallet.writeContract(request)
    await l1.waitForTransactionReceipt({ hash })
    // An idle local network builds no block, so the message would never be included: ask for an empty one.
    await debug.warpL2TimeAtLeastBy(1)
    log(`ROUND message of round ${config.roundId} sent (L1 tx ${hash}), content ${encodeRoundMessage(config).slice(0, 18)}…`)

    return { content, leaf: result[0], index: result[1] }
  }

  type Rule = { mode: 1 | 2; countries: string[] }
  const results: { e3Id: bigint; minAge: number; nationality?: Rule; circuit: string; txHash: string; logs: unknown[] }[] = []
  // The mock document's nationality is ZKR: it is in [ZKR, DEU], and not in [PRK, IRN].
  const rounds: [bigint, number, Rule | undefined][] = [
    [9001n, 0, undefined],
    [9002n, 18, undefined],
    [9003n, 0, { mode: NATIONALITY_MODE.IN, countries: ['ZKR', 'DEU'] }],
    [9004n, 18, { mode: NATIONALITY_MODE.OUT, countries: ['PRK', 'IRN'] }],
  ]
  for (const [roundId, minAge, nationality] of rounds) {
    const e3Id = e3IdOf(INTERFOLD, roundId)
    const now = await chainTime(deployer.node)
    const config: RoundConfig = {
      roundId,
      numOptions: 2n,
      credits: 10n,
      inputStart: BigInt(now),
      inputEnd: BigInt(now + 7 * 86_400),
      inputLimit: 16n,
      scopeHash: scopeHashOf(info.l1ChainId, program.address, e3Id),
      minAge: BigInt(minAge),
      allowMockDocuments: true,
      l1Registration: false,
      nationalityMode: nationality?.mode ?? NATIONALITY_MODE.NONE,
      nationalityCommitment: nationality ? await nationalityCommitment(nationality.mode, nationality.countries) : 0n,
    }
    await crisp.openRound(config, await sendRound(config))
    log(`round ${roundId} (e3 ${e3Id}) open on Aztec (min age ${minAge}, nationality ${JSON.stringify(nationality ?? null)})`)

    // The voter: a fresh account; the proof is bound to it and to this round's scope.
    const voter = await connectAztec(NODE_URL)
    try {
      const client = await CrispAztec.connect(voter, crisp.address)
      const proofStarted = Date.now()
      const proof = await generateMockRegistrationProof({
        aztecAddress: voter.address.toString(),
        domain: domainHash(DOMAIN),
        scope: scopeOf(info.l1ChainId, program.address, e3Id),
        minAge,
        nationality,
        now: await chainTime(voter.node),
        documentNumber: `ZKR${roundId}`,
      })
      log(`${proof.circuit} proof generated in ${((Date.now() - proofStarted) / 1000).toFixed(1)}s (nullifier type ${proof.nullifierType})`)

      const slot = getAddress(`0x${roundId.toString(16).padStart(40, '0')}`)
      const sent = await client.register({ e3Id, slot, proof })
      const logs = await client.logs('MemberRegistered', { e3Id })
      log(`registered slot ${slot} for e3 ${e3Id}: tx ${sent.txHash} block ${sent.blockNumber}`)
      results.push({ e3Id, minAge, nationality, circuit: proof.circuit, txHash: sent.txHash, logs })
    } finally {
      await voter.stop()
    }
  }

  // ---- Controls: the checks are live, so each of these proofs must be refused ----
  // Round 9001 (no age) already holds document ZKR9001. A fresh voter tries to register with each flawed proof.
  if (process.env.SKIP_CONTROLS !== '1') {
    const e3Id = e3IdOf(INTERFOLD, 9001n)
    const domain = domainHash(DOMAIN)
    const scope = scopeOf(info.l1ChainId, program.address, e3Id)
    const refused: { control: string; error: string }[] = []
    const expectRefused = async (control: string, run: (voter: AztecSession, client: CrispAztec) => Promise<unknown>) => {
      const voter = await connectAztec(NODE_URL)
      try {
        const client = await CrispAztec.connect(voter, crisp.address)
        await run(voter, client)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        refused.push({ control, error: message.split('\n')[0]!.slice(0, 240) })
        log(`control "${control}" refused: ${refused.at(-1)!.error}`)

        return
      } finally {
        await voter.stop()
      }
      throw new Error(`Control "${control}" was accepted: the proof check is not enforced`)
    }
    const prove = async (voter: AztecSession, options: { documentNumber: string; scope?: string; boundTo?: AztecSession }) =>
      generateMockRegistrationProof({
        aztecAddress: (options.boundTo ?? voter).address.toString(),
        domain,
        scope: options.scope ?? scope,
        now: await chainTime(voter.node),
        documentNumber: options.documentNumber,
      })
    const slot = (n: number) => getAddress(`0x${n.toString(16).padStart(40, '0')}`)

    await expectRefused('a proof with one corrupted byte', async (voter, client) => {
      const proof = await prove(voter, { documentNumber: 'ZKRBAD001' })
      const at = 64 * (proof.publicInputs.length + 100) + 5
      const corrupted = `${proof.proof.slice(0, at)}${proof.proof[at] === '0' ? '1' : '0'}${proof.proof.slice(at + 1)}`
      await client.register({ e3Id, slot: slot(1), proof: { proof: corrupted, vkeyHash: proof.vkeyHash } })
    })
    await expectRefused('a proof bound to another account', async (voter, client) => {
      const other = await connectAztec(NODE_URL)
      try {
        const proof = await prove(voter, { documentNumber: 'ZKRBAD002', boundTo: other })
        await client.register({ e3Id, slot: slot(2), proof })
      } finally {
        await other.stop()
      }
    })
    await expectRefused("a proof for another round's scope", async (voter, client) => {
      const proof = await prove(voter, { documentNumber: 'ZKRBAD003', scope: scopeOf(info.l1ChainId, program.address, e3IdOf(INTERFOLD, 1234n)) })
      await client.register({ e3Id, slot: slot(3), proof })
    })
    await expectRefused('the document that already registered', async (voter, client) => {
      const proof = await prove(voter, { documentNumber: 'ZKR9001' })
      await client.register({ e3Id, slot: slot(4), proof })
    })
    await expectRefused('a proof for another nationality list', async (voter, client) => {
      // Round 9003 asks for a nationality in [ZKR, DEU]; this proof is for [ZKR] alone.
      const e3 = e3IdOf(INTERFOLD, 9003n)
      const proof = await generateMockRegistrationProof({
        aztecAddress: voter.address.toString(),
        domain,
        scope: scopeOf(info.l1ChainId, program.address, e3),
        nationality: { mode: 1, countries: ['ZKR'] },
        now: await chainTime(voter.node),
        documentNumber: 'ZKRBAD005',
      })
      await client.register({ e3Id: e3, slot: slot(5), proof })
    })
    console.log(JSON.stringify(refused, null, 2))
  }
  await deployer.stop()
  console.log(JSON.stringify(results, (_, value) => (typeof value === 'bigint' ? value.toString() : value), 2))
  log(`done in ${((Date.now() - startedAt) / 1000).toFixed(0)}s`)
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error)
    process.exit(1)
  },
)
