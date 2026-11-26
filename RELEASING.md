# Releasing the CRISP packages

`@crisp-e3/sdk` and `@crisp-e3/contracts` are published as a matched pair on two channels.
`@crisp-e3/zk-inputs` and `@crisp-e3/aztec` are published with them, at the same version and under
the same tag.

| channel    | tag       | preset        | who it is for                      |
| ---------- | --------- | ------------- | ---------------------------------- |
| testing    | `testing` | `insecure-64` | testnets, demos, local development |
| production | `latest`  | both presets  | deployed clients and real rounds   |

## Why presets are separate entry points

The SDK inlines the compiled circuit and the contracts package ships the Solidity verifier generated
from that same circuit's verification key. A verifier only accepts proofs from the circuit it was
generated for, so mixing presets across the two packages produces a round that rejects every ballot
— and it fails at on-chain verification, not anywhere a test would catch it.

Each preset is a separate SDK subpath. The production package carries both subpaths so one client
can read the E3's on-chain `paramSet` and load the matching preset. The testing package carries only
the real insecure preset so local and testnet installs stay small. It also ships tiny stubs for the
other exported subpaths, so bundlers can resolve the client import graph without bundling secure
circuits into test builds.

```ts
// on @crisp-e3/sdk@testing
import { loadCircuits } from '@crisp-e3/sdk/insecure-64' // resolves
import { loadCircuits } from '@crisp-e3/sdk/secure-8192' // resolves, throws if called

// on @crisp-e3/sdk@latest
import { loadCircuits as loadInsecure } from '@crisp-e3/sdk/insecure-64'
import { loadCircuits as loadSecure } from '@crisp-e3/sdk/secure-8192'
```

This keeps the secure circuits out of testing installs while making the production client flexible
enough for secure mainnet rounds and insecure test deployments.

## Versioning

Testing releases carry a prerelease identifier; production releases do not.

```text
0.18.0-insecure.0   tag: testing    insecure-64
0.20.0              tag: latest     insecure-64 + secure-8192
```

The identifier is load-bearing. npm excludes prerelease versions from ordinary ranges, so a consumer
on `^0.18.0` can never drift onto a testing build through an update — reaching it takes an explicit
`@testing` or an exact version.

## The client tracks production

`client/` reads the E3 `paramSet` before proving and loads the matching preset. Because production
SDK releases carry both presets, a production publish moves `client/package.json` and
`client/pnpm-lock.yaml` to the published version. A testing publish leaves the client alone.

The same publish sets the client's `pnpm.overrides["@noir-lang/noir_js"]` to the exact `noir_js`
version in `packages/crisp-sdk/package.json`. The override keeps the client's tree on the Noir
runtime that the SDK proves with, so change the version in the SDK and the next production publish
carries it to the client. The publish fails if the SDK's version is a range or the client has no
override to move.

The pin cannot be a `workspace:` range, because the same `client/package.json` also serves the
standalone Vercel deploy, which installs with `ignore-workspace=true` (see `client/.npmrc`) and
cannot resolve one. So it is an exact version, and that has a consequence worth stating plainly:

**`linkWorkspacePackages: true` links `packages/crisp-sdk` only while its version still satisfies
that exact pin.** Bump the workspace to `0.20.0` while the client pins `0.19.1` and pnpm stops
linking and resolves the client from the registry instead. That is not a cosmetic difference. It
re-resolves the whole client dependency tree (it pulled `zod@4` in place of `zod@3` across `viem`,
`wagmi`, and `connectkit`), and it makes Vite pre-bundle the SDK as an ordinary dependency, which
breaks the worker subpath:

```text
The file does not exist at ".../client/node_modules/.vite/deps/
workers/generateCircuitInputs.worker.js?worker_file&type=module"
→ [generateProof] failed → the e2e vote never reaches the wallet signature
```

This is why a production publish leaves the CRISP workspace packages and the client on the same
exact version. A testing publish restores the versions it touched because the deployable client does
not track the testing channel.

## Procedure

Publish through `scripts/publish.ts`. It selects the preset from the release channel, builds the
packages, publishes in dependency order, and updates the standalone client lockfile after npm serves
the new SDK version.

SDK builds stage their required artifacts under `circuits/dist/<preset>/`, which git does not track.
The build refuses artifacts that are missing or older than the sources, using the content digest
that `stage-preset-artifacts.mjs` records at staging time.

The default SDK build is intentionally the lightweight testing build. It builds and ships only the
real `insecure-64` bundle, plus resolver stubs for off-channel presets, so pull-request CI does not
compile or bundle the large secure preset. Use the production channel, or
`pnpm -C packages/crisp-sdk build:prod`, when the output must include real
`insecure-64` and `secure-8192` bundles.

```sh
# testing — insecure-64 under the `testing` tag, leaves the client alone
pnpm publish:packages --channel testing 0.19.0-insecure.0

# production — both presets under the `latest` tag, and moves the client
pnpm publish:packages --channel prod 0.20.0
```

Add `--dry-run` to print the exact steps for a channel without changing anything. The script bumps
all four packages, builds the SDK against the channel's preset set, and publishes in dependency
order (`zk-inputs`, `sdk`, `contracts`, `aztec`). It never tags and never pushes.

### The Aztec SDK

`@crisp-e3/aztec` inlines the compiled Aztec contracts, and git does not track them. Compile them
before you publish:

```sh
cd extensions/aztec/contracts
aztec compile   # aztec CLI 6.0.0, from this directory
```

A client can only use a deployed contract whose class is the class of the inlined artifact. Thus,
publish from the sources that the deployed contracts were compiled from. The build has no preset: it
takes the base circuits from `@crisp-e3/sdk` at run time.

`check-dist.mjs` (`prepublishOnly`) refuses three builds: one whose artifacts are older than the
contract sources, one that is older than its artifacts, and one whose artifact is not transpiled
(it imports both entries).

What it leaves behind differs by channel. Production commits the bump so the tree and client stay on
the production version. Testing restores the version bump because the deployable client does not
track the testing channel. Either way, a failure restores the tree: a half-bumped workspace is worse
than no bump, because the next `pnpm install` silently detaches the client from it.

npm publication is not transactional. If npm accepts one or more packages before a later step fails,
confirm that the working tree was restored, then resume the same version:

```sh
pnpm publish:packages --channel prod --resume 0.20.0
```

`--resume` skips exact versions that npm already serves. Use it only for the same release attempt.
Before you resume, wait until npm serves every version that it accepted, for example with
`npm view @crisp-e3/zk-inputs@0.20.0 version`.

npm processes a publish asynchronously, and it can take about an hour to serve the new version. The
publisher therefore publishes all packages first. Then it waits until npm serves each new version,
for up to two hours for each package.

Two gates run on the way:

- `check-staged-preset.mjs` (in `build:testing` / `build:prod`) refuses staged artifacts the
  circuits have moved past.
- `check-presets.mjs` (`prepublishOnly` on both packages) refuses to publish a channel whose
  artifacts do not match its preset set — a missing preset, a wanted preset that is only a stub, an
  exports entry pointing at nothing, missing verifiers, or an unexpected real preset bundle.

## Deploying

Generated aggregator verifiers are preset-specific and committee-specific. The protocol deploys one
concrete PK and decryption verifier for each supported pair. A router selects the concrete verifier
from the proof's public-input length and VK hash anchors.

The SDK must also match the round. A `latest` SDK can load either supported preset. It selects the
preset from the E3's on-chain `paramSet`: `3` is `secure-8192` and `4` is `insecure-64`. Indices `0`
to `2` hold the tuples of earlier Interfold releases. Pair a `testing` SDK only with `insecure-64`
deployments.

For the v0.20.0 cutover, pause requests and wait until no E3 is active and every ended committee is
released. Deploy the OpenVM CRISP program from this release. Record the new program and verifiers in
`packages/crisp-contracts/deployed_contracts.json`.

The protocol commands run in `packages/interfold-contracts` of an Interfold checkout at tag
`v0.20.0`, after `pnpm install` in that checkout. The v0.20.0 release keeps the `upgrade:v19`
command names. `CRISP` is the path of the CRISP repository. Prepare the core activation batch with:

```sh
pnpm upgrade:v19 -- --network mainnet \
  --crisp-deployments "$CRISP/packages/crisp-contracts/deployed_contracts.json" \
  --openvm-identity <checked-cutover-identity.json> \
  --input-availability-signer <production-signer-address>
```

The identity file contains `appExeCommit`, `appVmCommit` and `halo2RuntimeCodeHash`. Verify these
values against the compiled guest and the deployed Halo2 verifier. Use `--config` and
`--deployment` when the operation uses separate protocol deployment records.

The script requires no active E3s or unreleased committees. It deploys the new Interfold
implementation and the BFV routes. The unsigned batch upgrades Interfold and registers the parameter
sets that the chain does not have: `3` on Mainnet, `3` and `4` on Sepolia. It also connects the
OpenVM program and raises the release policy to the protocol version and node generation of the
release (protocol `10`, generation `2`). Requests stay paused. Before resume, make sure that
`keccak256(paramSetRegistry(3))` is `BfvProtocol.SECURE_PARAM_SET_HASH` and that indices `0` to `2`
still hold their earlier bytes.

Publish this CRISP release before governance executes the contract switch. The core batch does not
replace the DAO's CRISP voting body. Requests now carry a committee-bound configuration identity, so
the governance voting plugin needs a build that computes that identity and points at the new CRISP
program. Install it with the complete governance batch, and rehearse that batch before signing.

After execution, run `upgrade:v19:validate -- --network mainnet`. Upgrade the ciphernodes. The node
storage schema changes from 8 to 9, so reset the node state with the new binary before the first
start. Upgrade the production services and set `E3_PARAM_SET` to `3` on Mainnet (`4` on Sepolia).
Refresh all remaining operators with `upgrade:v19:refresh -- --network mainnet`, then wait for a
later block. Confirm at least 19 distinct eligible bond owners and healthy release nodes before you
prepare resume:

```sh
pnpm upgrade:v19:resume -- --network mainnet --ciphernodes-restarted
```

The resume command validates the planned cutover and checks refreshed committee capacity before it
writes the separate DAO/Safe unpause transaction. It does not verify running process versions;
operators must check those separately.

An Aztec deployment pins the verification-key hashes of the base circuits. Deploy new Aztec
contracts for this release, and give their clients `@crisp-e3/aztec` at the same version.
