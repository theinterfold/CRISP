# Working on @crisp-e3/zk-inputs

This package only wraps the [`zk-inputs-wasm`](../../crates/zk-inputs-wasm) crate for Node and
browser bundlers; the witness logic lives in [`crates/`](../../crates/AGENTS.md). The
[README](README.md) owns usage. The SDK consumes it through `@crisp-e3/zk-inputs`.

- `dist/` is gitignored output of `scripts/build.js`. Never hand-edit it or commit it; rebuild it.
  The script runs `wasm-pack`, inlines the `.wasm` binary into `dist/index_base64.js`, deletes
  `index_bg.wasm`, and rewrites the `new URL('index_bg.wasm', …)` line in `dist/index.js` with a
  regex. A `wasm-bindgen` or `wasm-pack` upgrade that changes that line makes the replacement match
  nothing without failing the build, so confirm it still applies.
- The build script removes `dist` with `rm -rf` and rewrites it, so do not run it while the SDK
  build, the SDK tests, or the browser smoke test is reading `dist`.
- `wasm-bindgen` passes `Vec<i64>` as `BigInt64Array`, and the Rust side casts to `u64`. A change to
  argument types or to the `generateInputs` result shape (`encryptedVote`, `inputs`) is a break for
  the SDK encoding and the circuit witness consumers, even if this package still builds.

Check a change with `pnpm -C packages/crisp-zk-inputs build` and
`pnpm -C packages/crisp-zk-inputs test:browser`. The second needs Playwright's Chromium, or
`CHROME_BIN`, and only runs `generateKeys` and `encryptVote` in headless Chrome. It does not run
`generateInputs`, so a green run says nothing about witness shape or that Noir accepts the output.
Changes to inputs also need the SDK tests (`pnpm test:sdk`) and, for protocol-facing changes, the
circuits and e2e coverage the root guidance names.
