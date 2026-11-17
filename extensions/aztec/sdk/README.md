# `@crisp-e3/aztec`

TypeScript client for CRISP rounds whose ballots are cast on Aztec (v6): the voter flow, the keeper
operations and the L1 calls. The contract is [`../contracts`](../contracts), the L1 program
[`../l1`](../l1).

```ts
import {
  connectAztec,
  CrispAztec,
  buildCast,
  getRoundConfig,
  getSentMessages,
  registerOnL1Calldata,
  relayRegistrationOnL1,
} from '@crisp-e3/aztec'

const session = await connectAztec('http://localhost:8080') // a fresh account, fees paid by the SponsoredFPC
const crisp = await CrispAztec.connect(session, contractAddress)

await crisp.register({ e3Id, slot, proof: zkPassportResult }) // ZKPassport `compressed` result, bound to session.address
const census = await crisp.getCensus(e3Id) // rebuilt from MEMBER_REGISTERED logs
const cast = await buildCast({
  serverUrl,
  program,
  l1ChainId,
  e3Id,
  slot,
  census,
  ballot: { vote, sign } /* … */,
})
await crisp.cast(cast)
```

## Build and test

```bash
pnpm -C packages/crisp-sdk build
pnpm -C extensions/aztec/sdk build test
```

`@crisp-e3/sdk` resolves through its `dist`, so build it first. `src/bindings/CrispAztec.ts` is
generated from the compiled contract (`aztec compile` in `../contracts`) and imports
`../contracts/target/crisp_aztec-CrispAztec.json`: regenerate it with `pnpm codegen` whenever the
contract's ABI changes.

## Things that are not obvious

- **Two ids.** An Interfold e3Id is `interfold address ‖ 96-bit sequence`, which does not fit an
  Aztec field. The contract and the L1→L2/L2→L1 messages carry only the low 96 bits (`roundId`,
  `roundIdOf`); everything the SDK takes or returns is the full `e3Id` (`e3IdOf(interfold, roundId)`
  is the inverse), and so are the EIP-712 digests, the server and the scope string. `CrispAztec`
  reads the contract's `interfold` at `connect` and converts internally; logs carry both ids. The
  message encoders (`encodeRoundMessage`, `roundContent`, …) take `roundId`.
- **The circuit preset is the caller's job.** `buildCast` proves with whatever `setCircuits`
  registered; call `setCircuits(await loadCircuits())` from the `@crisp-e3/sdk/<preset>` subpath
  that matches the round first.
- **Ballots are proven by the three base circuits, not the fold.** `cast` verifies the
  `user_data_encryption_ct0`, `user_data_encryption_ct1` and crisp proofs itself and makes the
  checks the two aggregation circuits make on L1 (`contracts/crisp_aztec/src/ballot.nr` lists them),
  so `buildCast` asks `finishBallotBase` for the base proofs only: no 2^21-gate aggregation proof,
  no fold. They are `noir-recursive-no-zk` proofs (410 fields, 115-field verification key): they
  are private arguments of `cast`, hidden by the transaction proof, and must never be sent
  anywhere else (`buildCast` stages only the ciphertext with the server). The contract is deployed
  with the hashes of the three verification keys of the round's BFV preset; `pnpm base-vk-hashes
  <preset>` prints them (`getBaseVerificationKeys` after `setCircuits`). Unlike the fold's, they
  differ per preset, so a deployment serves one preset.
- **A session is disposable.** `connectAztec` makes an initializerless Schnorr account from random
  keys: no deployment transaction, nothing stored. A ZKPassport proof is bound to that address, so
  register and cast from the same session you proved for.
- **Sessions prove client-side.** `connectAztec(url, { prove })` defaults to `true`. The embedded
  wallet's simulation skips the `verify_honk_proof_non_zk` recursion, so unproven transactions are not
  checked against the ZKPassport or fold proof; a public network rejects them, a local network
  accepts them.
- **The SponsoredFPC is not visible through `getContract`.** The local network funds it at genesis
  without publishing its instance, so the session does not check for it; a transaction fails if the
  network has none.
- **L1→L2 messages need a block.** `openRound` and `publishKey` wait until a block includes the
  Inbox message (`getL1ToL2MessageIndex` is its leaf index). A local network builds blocks only for
  transactions, so an idle one never includes the message: send any transaction after the L1 call.
- **`getRootWitness` is empty until the epoch's proof is on L1.** Ask again later; the keeper does.
- **Staging needs a pass.** The server stages a ciphertext only against a staging pass: a zero-knowledge
  proof that the sender holds the key of SOME slot registered in the round's census, with a one-time tag
  (`buildStagingPass`, `staging-pass.ts`; circuit `extensions/core/circuits/staging_pass`). `buildCast` makes
  it from its `staging: { signer, maxRequests, counter }`. `signer` is the voter's OWN registered slot key,
  for a vote and for a mask alike (a mask's `slot` is the masked one), so the server cannot tell them
  apart; an unregistered voter cannot stage. `maxRequests` is `getRemoteInputConfig().staging_max_requests`.
  `counter` is the next unused pass of that key in that round, `0 <= counter < maxRequests`: the server
  accepts each once, so count every staging, vote or mask, per key and round on the client (a refused one
  still spends its counter, as the server keeps the tag when it refused something the caller sent). Pass
  proofs are about 6 s in Node (2^17 gates, own bb.js instance: call `destroyStagingPassProver()` at
  shutdown, next to `destroyBBApi`). Tags are unlinkable to slots only while the slot public key stays
  unpublished: never publish a signature made with a slot key outside the ballot proof.
  `stagingRequestDigest` is what the pass signs, and `server/tests/fixtures/staging_pass.json` is refreshed
  from the SDK test with `WRITE_STAGING_FIXTURE=1` (the server's Rust tests verify it).
- **The server attests the ciphertext.** `buildCast` stages it through `POST /voting/remote-input`
  and passes the server's 64-byte `r ‖ s` signature to the contract. The availability signer the
  contract trusts is fixed at deploy (`deployCrispAztec`, `signer_public_key` from
  `GET /voting/remote-input/config`); `buildCast` checks the signature before spending a transaction
  on it.
- **Registration picks its entry point by round.** `register` reads the round's rules and calls `register`
  (no rule, a 4-subproof ZKPassport capsule), `register_with_age` (5), `register_with_nationality` (5) or
  `register_with_age_and_nationality` (6). It throws for a round that registers on L1.
- **A round's rules are one 8-field custom-params value.** `encodeCustomParams` / `decodeCustomParams` (with
  `RoundRules`) build and read what `Interfold.request` carries; `assertRules` rejects what L1 would
  (a minimum age above 99, a list that does not match the mode, more than 200 or duplicate countries,
  a commitment where there should be none). `nationalityCommitment(mode, countries)` (async) is the value
  an Aztec-path round with a nationality rule must carry; it matches the Noir fixtures and sorts exclusion
  lists, and `registrationSubproofs(rules)` is the ZKPassport proof's size (4 to 6).
- **The L1 path needs no Aztec account.** `registerOnL1Calldata({ e3Id, slot, params, countries })` encodes
  `ZKPassportRegistrar.register` for a proof the ZKPassport app produced (`registrarAbi` is the ABI), and
  `relayRegistrationOnL1(serverUrl, calldata)` posts it to the CRISP server's `POST /registration/l1`,
  which pays for the transaction; the server's registrar address is `zkpassport_registrar` in
  `getRemoteInputConfig`. The proof must be bound to the slot (`senderAddress = slot`), not to an Aztec
  address. The keeper then moves the slot to Aztec (`getSentMembers` lists the MEMBER messages;
  `addMemberFromL1(e3Id, slot, message)` is what it calls).
- **Digests are signed raw.** `DigestSigner` signs the EIP-712 digest itself, without the EIP-191
  prefix.
- **Tests that read `extensions/aztec/l1`.** `tests/messages.test.ts` and `tests/l1Abi.test.ts`
  compare against the L1 package's message vectors and exported ABI; run
  `pnpm -C extensions/aztec/l1 export:abi` after changing the program.
