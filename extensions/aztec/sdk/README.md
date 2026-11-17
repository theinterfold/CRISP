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
- **Fold proofs are `noir-recursive`.** `cast` verifies the fold proof inside the contract, so
  `buildCast` asks `finishBallot` for `verifierTarget: 'noir-recursive'` (458 proof fields, 115
  verification-key fields). The contract is deployed with the hash of that verification key;
  `pnpm fold-vk-hash` prints it (one value for every preset).
- **A session is disposable.** `connectAztec` makes an initializerless Schnorr account from random
  keys: no deployment transaction, nothing stored. A ZKPassport proof is bound to that address, so
  register and cast from the same session you proved for.
- **Sessions prove client-side.** `connectAztec(url, { prove })` defaults to `true`. The embedded
  wallet's simulation skips the `verify_honk_proof` recursion, so unproven transactions are not
  checked against the ZKPassport or fold proof; a public network rejects them, a local network
  accepts them.
- **The SponsoredFPC is not visible through `getContract`.** The local network funds it at genesis
  without publishing its instance, so the session does not check for it; a transaction fails if the
  network has none.
- **L1→L2 messages need a block.** `openRound` and `publishKey` wait until a block includes the
  Inbox message (`getL1ToL2MessageIndex` is its leaf index). A local network builds blocks only for
  transactions, so an idle one never includes the message: send any transaction after the L1 call.
- **`getRootWitness` is empty until the epoch's proof is on L1.** Ask again later; the keeper does.
- **The server attests the ciphertext.** `buildCast` stages it through `POST /voting/remote-input`
  and passes the server's 64-byte `r ‖ s` signature to the contract. The availability signer the
  contract trusts is fixed at deploy (`deployCrispAztec`, `signer_public_key` from
  `GET /voting/remote-input/config`); `buildCast` checks the signature before spending a transaction
  on it.
- **Registration picks its entry point by round.** A round with a minimum age uses
  `register_with_age` (a 5-subproof ZKPassport capsule), the others `register` (4).
- **Digests are signed raw.** `DigestSigner` signs the EIP-712 digest itself, without the EIP-191
  prefix.
- **Tests that read `extensions/aztec/l1`.** `tests/messages.test.ts` and `tests/l1Abi.test.ts`
  compare against the L1 package's message vectors and exported ABI; run
  `pnpm -C extensions/aztec/l1 export:abi` after changing the program.
