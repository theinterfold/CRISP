# ZKPassport fixtures for the Aztec local network

Dev tooling that lets `CrispAztec.register` / `register_with_age` run on a local Aztec network with **real
ZKPassport proofs**, no passport and no phone needed.

What is real: every subproof (certificate, ID data, integrity, age, bind) is proved with `bb` 6.0.0 and aggregated
by the published `outer_count_4` / `outer_count_5` circuits of ZKPassport circuits release **0.22.0** (the release
built for bb 6.0.0), exactly as the ZKPassport app produces a `compressed`-mode proof. What is synthetic: the
passport (issuing country `ZKR`, ICAO's mock code, so the nullifier type is `NON_SALTED_MOCK`) and the certificate
authority that signs it. The contract accepts mock documents only for rounds opened with `allowMockDocuments`
(`dev_mode`); nothing in the contract is bypassed.

## Use

Prerequisites: Aztec 6.0.0 on the `PATH` (it ships `bb` 6.0.0), network access to `circuits2.zkpassport.id` and
GitHub (first run only), a local network (`aztec start --local-network`).

```bash
export PATH=$HOME/.aztec/versions/6.0.0/bin:$HOME/.aztec/bin:$PATH
cd extensions/aztec/e2e
pnpm tsx zkpassport/src/demo.ts   # ~3 min: seeds the registry, opens 2 rounds, registers, runs the negative controls
```

`demo.ts` deploys the vendored `ZKPassportRegistry` at its canonical address and seeds it, deploys `CrispAztec`
(its `l1_program` is anvil account 7, which stands in for `CRISPAztecProgram` and sends real Inbox messages), opens
a round without age (`outer_count_4`) and one with `min_age` 18 (`outer_count_5`) using the real scope hash, lands
`register` and `register_with_age`, prints the `MemberRegistered` logs, then checks that four flawed proofs are
refused (a corrupted proof, a proof bound to another account, a proof for another round's scope, a document that
already registered). `SKIP_CONTROLS=1` skips the controls.

```ts
import {
  LOCAL_NETWORK_REGISTRY_ADDRESS,
  chainTime,
  circuitsVersionField,
  connectRegistryContext,
  domainHash,
  generateMockRegistrationProof,
  mockRegistryRoots,
  seedLocalRegistry,
} from './zkpassport/src'

const context = await connectRegistryContext(nodeUrl)
await seedLocalRegistry(context) // idempotent: deploys, seeds the mock roots + both outer vks, warps the clock once
await context.stop()

// CrispAztec is deployed with
//   zkpassportRegistry: LOCAL_NETWORK_REGISTRY_ADDRESS, zkpassportCircuitVersion: circuitsVersionField(),
//   zkpassportDomainHash: domainHash('<your domain>')

const proof = await generateMockRegistrationProof({
  aztecAddress: session.address.toString(), // the proof is bound to the sender
  domain: domainHash('<your domain>'),
  scope: scopeOf(chainId, l1Program, e3Id), // `crisp-aztec:<chainId>:<program>:<e3Id>`; hashed to the round's scope_hash
  minAge: 18, // 0 → outer_count_4 (register), > 0 → outer_count_5 (register_with_age)
  now: await chainTime(session.node), // the proof's date: the contract checks it against the L2 block
  documentNumber: 'ZKR000001', // ≤ 9 chars of A-Z0-9<; one registration per document and round
})
await client.register({ e3Id, slot, proof }) // `proof` is { proof, vkeyHash }, like a ZKPassport compressed result
```

`generateMockRegistrationProof` takes ~25 s (no age) or ~32 s (age). `mockRegistryRoots()` returns what a registry must
hold (certificate root, circuit root, `outer_count_4/5` vk hashes) without proving anything.

## Ordering and time

- The registry is a `DelayedPublicMutable` with a 24 h delay: a root or vk written now is invisible to private reads
  for 86 400 s. `seedLocalRegistry` therefore **warps the network (L1 and L2) forward ~24 h once** through the node
  debug API (`warpL2TimeAtLeastTo`). Run it before anything time-sensitive (an Interfold E3 request, input windows),
  and never between a request and its deadline. It is a no-op once seeded.
- Proofs take `now` = the latest L2 block timestamp. The contract requires `now <= anchor_ts + 3600` and
  `now + validity > anchor_ts`; after the warp the chain is ahead of the wall clock, so do not use `Date.now()`.
- Register after the round's message has been included in a block. A local network builds a block only when a tx is
  pending, so `demo.ts` asks for an empty one with `warpL2TimeAtLeastBy(1)` after each Inbox message.
- Sessions must prove client-side: `connectAztec` does by default. The embedded wallet's simulation does not run the
  `verify_honk_proof` recursion, so a session created with `{ prove: false }` accepts corrupted ZKPassport proofs.

## Files and caches

- `src/proof.ts`: `generateMockRegistrationProof`, `mockRegistryRoots`, `scopeHash`, `packCircuitVersion`.
- `src/prove-mock.cts`: the prover. It runs inside a checkout of `zkpassport/circuits` at tag `noir-v1.0.0` (commit
  `327d19e`, built for bb 6.0.0) with that checkout's own dependencies, because `@zkpassport/utils` must not be
  loaded twice. `scripts/setup-circuits.mjs` creates the checkout on first use.
- `src/registry.ts`: deploy and seed the registry, `warpTo`, `chainTime`, `domainHash`, `circuitsVersionField`.
- `.cache/` (gitignored): the circuits checkout, the circuit manifest and compiled circuits, the synthetic authority
  (`pki.json`, so the certificate root stays the same and the registry is seeded once) and its DSC proof.

## Real ZKPassport app (not exercised here)

On a network where the real registry is seeded, a proof from the ZKPassport app works unchanged: circuits release
0.22.0, `mode: 'compressed'`, `bind: { user_address }` set to the voter's Aztec address, `scope` = the round scope
string, `domain` such that its hash equals the contract's `zkpassport_domain`, and `devMode: true` only for mock
documents (rounds with `allowMockDocuments`).
