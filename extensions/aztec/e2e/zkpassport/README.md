# ZKPassport mock proofs for the Aztec local network

Dev tooling (used by the `../src` e2e harness) that lets `CrispAztec.register*` run on a local Aztec network with **real ZKPassport
proofs**, no passport needed. Every subproof is proved with `bb` 6.0.0 and aggregated by the published `outer_count_4` / `_5` / `_6`
circuits of ZKPassport circuits release **0.23.0** (built for bb 6.0.0; its outer proofs end with the `verification_method` public
input). Only the passport (issuing country `ZKR`, ICAO's mock code) and the certificate authority that signs it are synthetic; the
contract accepts mock documents only for rounds opened with `allowMockDocuments`.

Prerequisites: Aztec 6.0.0 on the `PATH` (it ships `bb` 6.0.0), network access to `circuits2.zkpassport.id` and GitHub (first run only),
a local network (`aztec start --local-network`).

```ts
import { connectRegistryContext, seedLocalRegistry, generateMockRegistrationProof, chainTime, domainHash, circuitsVersionField,
         LOCAL_NETWORK_REGISTRY_ADDRESS } from './zkpassport/src'

const context = await connectRegistryContext(nodeUrl)
await seedLocalRegistry(context) // idempotent: deploys, seeds the mock roots + the outer vks, warps the clock once
// deploy CrispAztec with zkpassportRegistry: LOCAL_NETWORK_REGISTRY_ADDRESS, zkpassportCircuitVersion: circuitsVersionField(),
// zkpassportDomainHash: domainHash('<your domain>')

const proof = await generateMockRegistrationProof({
  aztecAddress: session.address.toString(), // the proof is bound to the sender
  domain: domainHash('<your domain>'),
  scope: scopeOf(chainId, l1Program, e3Id), // hashed to the round's scope_hash
  minAge: 18, // 0 → outer_count_4, > 0 → outer_count_5
  nationality: { mode: 1, countries: ['ZKR'] }, // optional rule (the mock document's nationality is ZKR)
  now: await chainTime(session.node), // the contract checks it against the L2 block
  documentNumber: 'ZKR000001', // ≤ 9 chars of A-Z0-9<; one registration per document and round
})
await client.register({ e3Id, slot, proof })
```

A proof takes ~25 s (no age) or ~32 s (age).

## Gotchas

- The registry is a `DelayedPublicMutable` with a 24 h delay: a root or vk written now is invisible to private reads for 86 400 s.
  `seedLocalRegistry` therefore **warps the network (L1 and L2) forward ~24 h once**. Run it before anything time-sensitive (an
  Interfold E3 request, input windows), never between a request and its deadline. It is a no-op once seeded.
- Proofs take `now` = the latest L2 block timestamp (the contract requires `now <= anchor_ts + 3600`); after the warp the chain is
  ahead of the wall clock, so do not use `Date.now()`.
- Register after the round's message has been included in a block: a local network builds a block only when a tx is pending, so ask
  for an empty one with `warpL2TimeAtLeastBy(1)` after each Inbox message.
- Sessions must prove client-side (`connectAztec` does by default): the embedded wallet's simulation does not run the
  `verify_honk_proof` recursion, so `{ prove: false }` accepts corrupted ZKPassport proofs.

## Files

- `src/proof.ts`: `generateMockRegistrationProof`, `mockRegistryRoots`, `scopeHash`, `packCircuitVersion`.
- `src/prove-mock.cts`: the prover. It runs inside a checkout of `zkpassport/circuits` at commit `4d90f1f` ("Release 0.23.0", no git
  tag) with that checkout's own dependencies, because `@zkpassport/utils` must not be loaded twice. `scripts/setup-circuits.mjs`
  creates the checkout on first use; delete `.cache/circuits` of an older release first.
- `src/registry.ts`: deploy and seed the registry, `warpTo`, `chainTime`, `domainHash`, `circuitsVersionField`.
- `.cache/` (gitignored): the circuits checkout, compiled circuits and the synthetic authority (`pki.json`, so the certificate root
  stays the same and the registry is seeded once).

A proof from the real ZKPassport app works unchanged on a network with the real registry: release 0.23.0, `mode: 'compressed'`,
`bind: { user_address }` the voter's Aztec address, `scope` the round scope string, a `domain` hashing to the contract's
`zkpassport_domain`, and `devMode: true` only for mock documents.
