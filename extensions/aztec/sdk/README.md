# `@crisp-e3/aztec`

TypeScript client for CRISP rounds whose ballots are cast on Aztec (v6): the voter flow, the keeper operations and the L1 calls.
The contract is [`../contracts`](../contracts), the L1 program [`../l1`](../l1).

```ts
import { connectAztec, CrispAztec, buildCast } from '@crisp-e3/aztec'

const session = await connectAztec('http://localhost:8080') // a fresh account, fees paid by the SponsoredFPC
const crisp = await CrispAztec.connect(session, contractAddress)

await crisp.register({ e3Id, slot, proof: zkPassportResult }) // ZKPassport `compressed` result, bound to session.address
const census = await crisp.getCensus(e3Id) // rebuilt from MEMBER_REGISTERED logs
const cast = await buildCast({ serverUrl, program, l1ChainId, e3Id, slot, census, ballot: { vote, sign } /* … */ })
await crisp.cast(cast)
```

## Build and test

```bash
pnpm -C packages/crisp-sdk build
pnpm -C extensions/aztec/sdk build test
```

`@crisp-e3/sdk` resolves through its `dist`, so build it first. `src/bindings/CrispAztec.ts` is generated from the compiled
contract (`aztec compile` in `../contracts`): regenerate it with `pnpm codegen` whenever the contract's ABI changes.
`tests/messages.test.ts` and `tests/l1Abi.test.ts` compare against the L1 package's message vectors and ABI; run
`pnpm -C extensions/aztec/l1 export:abi` after changing the program.

## Things that are not obvious

- **Two ids.** The contract and the L1↔L2 messages carry only the low 96 bits of the e3Id (`roundId`, `roundIdOf`); everything the
  SDK takes or returns is the full `e3Id` (`e3IdOf(interfold, roundId)` inverts it), as are the EIP-712 digests, the server and the
  scope string. `CrispAztec` reads the contract's `interfold` at `connect` and converts internally. The message encoders
  (`encodeRoundMessage`, `roundContent`, …) take `roundId`.
- **The circuit preset is the caller's job.** `buildCast` proves with whatever `setCircuits` registered; call
  `setCircuits(await loadCircuits())` from the `@crisp-e3/sdk/<preset>` subpath that matches the round first.
- **Ballots are proven by the three base circuits, not the fold.** `buildCast` asks `finishBallotBase` for the base proofs only.
  They are `noir-recursive-no-zk` proofs private to `cast` and must never be sent anywhere else (`buildCast` stages only the
  ciphertext with the server). The contract is deployed with the hashes of the three verification keys of the round's BFV
  preset; `pnpm base-vk-hashes <preset>` prints them (`getBaseVerificationKeys` after `setCircuits`), so a deployment serves one
  preset.
- **A session is disposable** (a random initializerless Schnorr account, nothing stored). A ZKPassport proof is bound to its
  address, so register and cast from the same session you proved for.
- **Sessions must prove client-side.** `connectAztec(url, { prove })` defaults to `true`. The embedded wallet's simulation skips
  the `verify_honk_proof` recursion, so unproven transactions are not checked against the ZKPassport or ballot proofs; a public
  network rejects them, a local network accepts them.
- **The SponsoredFPC is not visible through `getContract`**, so the session does not check for it; a transaction fails if the
  network has none.
- **L1→L2 messages need a block.** `openRound` and `publishKey` wait until a block includes the Inbox message; an idle local
  network builds none, so send any transaction after the L1 call.
- **`getRootWitness` is empty until the epoch's proof is on L1.** Ask again later; the keeper does.
- **Staging needs a pass.** The server stages a ciphertext only against a staging pass (`buildStagingPass`; circuit
  `extensions/core/circuits/staging_pass`, see `../README.md`). `buildCast` makes it from its `staging: { signer, maxRequests,
  counter }`. `signer` is the voter's OWN registered slot key, for a vote and a mask alike (a mask's `slot` is the masked one).
  `maxRequests` is `getRemoteInputConfig().staging_max_requests`. `counter` is the next unused pass of that key in that round,
  `0 <= counter < maxRequests`: count every staging, vote or mask, per key and round on the client (a refused one still spends its
  counter). A pass takes about 6 s in Node and has its own bb.js instance: call `destroyStagingPassProver()` at shutdown, next to
  `destroyBBApi`. Never publish a signature made with a slot key outside the ballot proof. `server/tests/fixtures/staging_pass.json`
  is refreshed from the SDK test with `WRITE_STAGING_FIXTURE=1`.
- **The server attests the ciphertext.** `buildCast` stages it through `POST /voting/remote-input` and passes the server's 64-byte
  `r ‖ s` signature to the contract. The availability signer the contract trusts is fixed at deploy (`deployCrispAztec`,
  `signer_public_key` from `GET /voting/remote-input/config`); `buildCast` checks the signature before spending a transaction.
- **Registration picks its entry point by round**: `register` reads the round's rules and calls the matching `register*` (a 4 to 6
  subproof ZKPassport capsule).
- **A round's rules are one 7-field custom-params value.** `encodeCustomParams` / `decodeCustomParams` (with `RoundRules`) build and
  read what `Interfold.request` carries; `assertRules` rejects what L1 would. `nationalityCommitment(mode, countries)` (async) is
  the value a round with a nationality rule must carry (it sorts exclusion lists); `registrationSubproofs(rules)` is the ZKPassport
  proof's size (4 to 6).
- **Digests are signed raw** (`DigestSigner`: the EIP-712 digest itself, no EIP-191 prefix).
