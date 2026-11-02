# Working on Noir circuits

`lib/src/` holds the shared constraints; `bin/crisp` and `bin/crisp_onchain` are the ballot
circuits, and `bin/fold` and `bin/fold_onchain` fold a ballot proof with the Interfold
`user_data_encryption` proofs. The `user_data_encryption` circuits and `interfold_lib` come from the
pinned Interfold release, not from here. The [root README](../Readme.md#interfold-dependency) owns
the release move and the circuit commands; [RELEASING.md](../RELEASING.md) owns how staged circuits
reach the SDK.

- The fold `main` signature is a proof interface. The order of its `pub` inputs and of the array it
  passes to the ballot proof, the return tuples, and the witness names are read by the SDK
  (`packages/crisp-sdk/src/vote.ts`, `envelope.ts`) and by the verifiers behind `IHonkVerifier` in
  `packages/crisp-contracts`. Position 4 is `merkle_root` in one stack and `voting_power` in the
  other by design. Reorder or rename nothing without changing every consumer in the same change.
- `CRISPVerifier.sol` and `CRISPOnchainVerifier.sol` are generated from the fold circuits by
  `scripts/compile_circuits.sh`, which also patches them. Never edit them by hand. Any change to a
  fold circuit, including a key hash constant, changes its verifier, so regenerate and commit both.
  Contract tests that use `MockHonkVerifier` do not exercise the real verifier.
- `lib/src/preset.nr` is rewritten on every compile, and the committed file must select
  `insecure-64`. Compiling or running `pnpm compute:vk-hash secure-8192` leaves the tree on the
  secure preset; finish with an `insecure-64` pass and do not commit the secure selector.
- The `*_EXPECTED_KEY_HASH_INSECURE`/`_SECURE` constants in `bin/fold` and `bin/fold_onchain` bind
  the inner circuits' verification keys. They go stale when a ballot circuit, `lib/`, or the
  Interfold release changes, and `nargo test` never notices. Regenerate both presets with
  `pnpm compute:vk-hash`, replace only the constants that moved, then recompile.
- Staged SDK artifacts are checked against a content digest of `bin/crisp`, `bin/crisp_onchain`,
  `lib/`, and `interfold-release.json` (`.nr` and `.toml` files only; see
  `scripts/circuit-sources.mjs`). A comment-only edit there makes `circuits/dist/` stale, while
  `bin/fold*` and `preset.nr` do not count. Restage with `pnpm build:presets`; never hand-edit
  `circuits/dist/<preset>/preset.json`.
- `compile_circuits.sh` and `compute_vk_hash.sh` overwrite `preset.nr` and the verifier files and
  need `nargo`, `bb`, and `python3`. Do not run them, or `pnpm build:presets`, concurrently in one
  checkout.

The smallest check is `pnpm test:circuits` (`nargo test` in `lib/`, as the `crisp_unit_circuits` CI
job does), with the `nargo` version `NOIR_TOOLCHAIN` pins in `.github/workflows/ci.yml`. It runs
only `lib/` tests: the `bin/` mains have none, so a compile error or a stale key hash there shows up
only in `pnpm compile:circuits`. Interface changes also need `pnpm compute:vk-hash`,
`pnpm test:sdk`, and `pnpm test:contracts:unit`. These checks do not prove a real folded proof
verifies on chain; that needs a real-proof SDK or contract run, and the `secure-8192` preset needs
its own pass.
