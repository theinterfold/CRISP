# Working on the CRISP SDK

This package owns ballot proving, encoding, and the CRISP server and chain helpers. It inlines
circuits that [`circuits/`](../../circuits) compiles and stages; it does not define them.
[README.md](README.md) owns usage and preset selection; [RELEASING.md](../../RELEASING.md) owns the
channel and publish rules.

- Each preset subpath (`insecure-64`, `secure-8192`) inlines the circuits staged under
  `circuits/dist/<preset>/`, which git does not track. A wrong or stale bundle passes local tests
  and only fails at on-chain verification. `build:testing` and `build:prod` do not compile; they run
  `check:staged`, which compares a source digest and refuses stale archives. Restage with
  `build:presets` or `build:presets:all` rather than editing `circuits/dist`.
- `pnpm build` is the testing build: real `insecure-64`, resolver stubs (`*.unavailable.ts`) for
  `secure-8192`. Anything that needs the real secure bundle needs `build:prod`. Adding a preset or
  export means updating `tsup.config.js`, the `exports` map, the stubs, and
  `scripts/check-presets.mjs` together; its channel gate fails on missing, stub-only, or unexpected
  real bundles.
- `build:presets` runs `compile_circuits.sh`, which switches `circuits/lib/src/preset.nr`, compiles,
  and writes the Solidity verifiers into `packages/crisp-contracts`. It rewrites tracked files,
  takes one preset at a time (never run two concurrently), and leaves the tree on `insecure-64`.
  Ballot circuit changes also need the fold key hashes from `pnpm compute:vk-hash <preset>`.
- The worker is a separate export built from `src/workers/`; `vote.ts` loads it through
  `new URL('./workers/generateCircuitInputs.worker.js', import.meta.url)`. Keep that path and the
  export entry in step. The client keeps `@crisp-e3/sdk` out of Vite pre-bundling for this reason
  (`client/vite.config.ts`), and a mocked worker or Node-only test does not exercise it.
- `client/package.json` pins this package's exact version, and `linkWorkspacePackages: true` links
  the workspace copy only while that version satisfies the pin. Bump the SDK, `crisp-zk-inputs`, and
  `crisp-contracts` versions only through `pnpm publish:packages` as RELEASING.md describes.
- `requestNewRound` sends the server's `cron_api_key` in the JSON body, so it rejects non-loopback
  HTTP, credentials, query or fragment in the URL, and redirects. Do not weaken those checks or copy
  the key into other helpers, logs, or error messages.

For a package-local check, run `pnpm -C packages/crisp-sdk test` (or `pnpm test:sdk` from the root).
It restages `insecure-64` from existing compiled circuits and the pinned Interfold release, then
runs Vitest. Preset, export, or worker changes also need `pnpm build:sdk`; production changes need
`pnpm -C packages/crisp-sdk build:prod` and
`CRISP_CHANNEL=latest pnpm -C packages/crisp-sdk check:presets`. Client behavior additionally needs
a `client/` build or the e2e run. None of these proves that the deployed verifier accepts the proof,
or that a browser worker loads from an installed registry package.
