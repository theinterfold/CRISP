# Working on the CRISP client

The client is a React/Vite browser app. It owns wallet and voting UX and adapts `@crisp-e3/sdk` for
proving and encryption; it does not own protocol, circuit, or contract behavior. The
[root Readme](../Readme.md#vercel-crisp-client) documents the Vercel deploy and
[RELEASING.md](../RELEASING.md#the-client-tracks-production) owns the SDK pin.

- `client/` is a workspace member and also a standalone package. `.npmrc` sets `ignore-workspace`,
  `vercel.json` installs with `pnpm install --ignore-workspace`, and `client/pnpm-lock.yaml` is the
  lockfile Vercel uses. Dependency changes must update that lockfile from inside `client/`, not only
  the root one, and must not assume a `workspace:` range or root `pnpm.overrides` resolve.
- `@crisp-e3/sdk` is an exact version, not a workspace range. pnpm's `linkWorkspacePackages` links
  `packages/crisp-sdk` only while its version satisfies that pin. A mismatch silently resolves the
  registry package, re-resolves the dependency tree, and breaks the SDK worker URLs in Vite. Move
  the pin only with the release flow, and keep the SDK entries in `vite.config.ts` `optimizeDeps`
  unbundled.
- Preset selection follows the E3's on-chain `paramSet`, read in `useVoteCasting` and mapped in
  `src/utils/circuits.ts`, never an env var or a hardcoded deployment mode. A new or unknown
  `paramSet` must fail rather than fall back to another preset, and each preset stays a separate
  dynamic import so the main bundle does not carry circuits.
- Everything under `VITE_*` is public in the built bundle. Never put `CRON_API_KEY` or any other
  server secret in `.env.example`, `vercel.json`, or client code; that key belongs only to protected
  server automation. `client/.env` is generated from `.env.example`, and `VITE_CRISP_TOKEN` is
  rewritten by the local deploy, so do not commit local values.
- COOP/COEP headers are set separately in `vercel.json` and the Vite dev server, next to the
  `@aztec-foundation/bb.js` worker handling in `vite.config.ts`. Changing one without the other
  makes dev and production behave differently, and a plain-code check will not catch it.
- Wallet flows are only truly exercised by the Playwright e2e in `../test/`, which drives MetaMask
  through Synpress against a local chain. Type checks and unit tests do not prove signing, network
  switching, or proof generation in a browser.

Run `pnpm build` in `client/` (`tsc` plus `vite build`) for the smallest check of client changes,
and `pnpm test:sdk` from the root when touching `src/utils/circuits.ts` or `src/utils/directVote.ts`
because the SDK `client-*.test.ts` files import them. Changes to voting, wallet, worker, or Vite
config need `pnpm test:e2e`, which starts the full local stack and takes several minutes. These
checks do not exercise the standalone Vercel install; verify that separately with
`pnpm install --ignore-workspace` in `client/`.
