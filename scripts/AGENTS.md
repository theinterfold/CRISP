# Working on repository scripts

Keep executable behavior in the owning script; the root `package.json` supplies the supported entry
points (`dev:setup`, `dev:up`, `test:e2e`, `compile:circuits`, `build:presets`, `publish:packages`,
`openvm`). [Readme.md](../Readme.md) owns local-stack usage, [RELEASING.md](../RELEASING.md) owns
the publish procedure, and [PROOF_AGGREGATION_AND_ZK.md](../docs/PROOF_AGGREGATION_AND_ZK.md) owns
the proof-aggregation modes that `lib/dev_config.sh` turns into environment.

- The dev scripts rewrite files and are not safe to run concurrently or against a stack you want to
  keep. `dev_cipher.sh` and `setup_testnet.sh` delete `.interfold/data` and `.interfold/config`;
  their cleanup `pkill -9`s every `interfold start` process on the machine, and `dev.sh` does the
  same to every `anvil`; `dev_server.sh` deletes `server/database`. A deploy rewrites the tracked
  `interfold.config.yaml` and `packages/crisp-contracts/deployed_contracts.json`, plus `server/.env`
  and `client/.env`; `dev:setup` also edits `E3_PARAM_SET` in `server/.env`.
- `dev:setup` always reinstalls the shared `~/.cargo/bin/interfold`, overwriting whatever other
  checkouts use. The binary must match `CRISP_SKIP_PROOF_AGGREGATION`, so changing that profile in
  `crisp.dev.env` needs a fresh `dev:setup`. Off Linux x86_64 the skip build compiles from the
  release tag.
- `interfold-release.mjs` refuses any download whose SHA-256 differs from `interfold-release.json`,
  and `circuits` deletes and recreates the untracked `circuits/interfold/`. Do not loosen the digest
  check to get past a mismatch; a new release is a coordinated change to the pin file, git tags,
  `Nargo.toml` files, and npm versions.
- `compile_circuits.sh` rewrites the tracked `circuits/lib/src/preset.nr` and the tracked generated
  verifiers, so presets cannot be built in parallel; `build-presets.mjs` ends on `insecure-64`, the
  committed preset. `circuit-sources.mjs` excludes `preset.nr` from the staging digest on purpose;
  keep `check-staged-preset.mjs` and `check-presets.mjs` strict rather than bypassing them.
- `publish.ts` bumps versions and lockfiles, publishes, and on the testing channel restores the
  bumped files from an in-memory snapshot, not from git. Keep that restore, the registry wait, and
  the rule that `--resume` skips only versions npm already serves; do not add a second sequence
  beside [RELEASING.md](../RELEASING.md).
- `setup_testnet.sh` sources a root `.env` and sends real Sepolia transactions, so local runs and
  mock deploys say nothing about it.

For script edits, run `bash -n` on the changed shell script, and for circuit tooling
`node scripts/check-staged-preset.mjs insecure-64` after `pnpm build:presets`. For publish changes,
use `pnpm publish:packages --channel testing --dry-run <x.y.z-prerelease>`, which makes no changes.
`pnpm test:e2e` is the broader check: it runs `dev.sh` with the real client and Playwright. None of
these publish to npm, prove the real-proof path (the default dev profile runs unproved), or touch
Sepolia.
