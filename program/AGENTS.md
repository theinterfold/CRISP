# Working on the CRISP program, guest and runner

`program/` is the ballot-selection policy and FHE processor that `CRISPProgram` agrees with. It owns
the leaf layout, the per-slot parent chain, and the tally; the OpenVM guest in `../guest/` proves it
and the runner in `../runner/` serves it. The guest and runner adapt this crate and carry no logic
of their own, so this file covers all three. [README.md](README.md) owns the compute flow and the
real-proof setup; [RELEASING.md](../RELEASING.md) owns deployment identity checks.

- `leaf` and the metadata layout (`slot || parentIndexPlusOne`) must stay byte-identical to
  `CRISPProgram.inputLeaf` in
  [the contract](../packages/crisp-contracts/contracts/CRISPProgram.sol). A divergence makes every
  round fail with no other symptom. The `include_str!` fixtures in
  `packages/crisp-contracts/tests/fixtures/` come from a real contract run: regenerate them with the
  TypeScript test that owns them, never by hand or to make a Rust test pass.
- Any change to what the guest compiles, including a `program/` edit, `guest/` config, the OpenVM or
  `e3-*` pins, or the guest's `RUSTFLAGS`, can change `appExeCommit` and `appVmCommit`.
  `OpenVmReceiptVerifier` is constructed with those values, so a verifier deployed for the old guest
  rejects proofs from the rebuilt one. Report that change; do not treat it as a refactor.
- `guest/` is a workspace of its own with its own `Cargo.lock`, and it builds `program/` with the
  `openvm-hashes` feature. The Interfold `e3-*` tag and the OpenVM tag are pinned in both
  `Cargo.toml` and `guest/Cargo.toml`; a release move updates both and refreshes both lockfiles, as
  the root [Readme](../Readme.md#interfold-dependency) lists. The guest's `--cfg crisp_openvm` and
  `--cfg crisp_fhe_optimized` come only from `scripts/openvm.sh`, so a bare `cargo build` in
  `guest/` is not the compiled guest.
- The guest swaps hashing, packing and commitments for accelerated versions that native tests never
  execute, so `cargo test` passing says nothing about them. The `crisp_openvm_guest` job closes that
  gap by running the built guest on a fresh fixture and comparing its revealed SHA-256 against the
  host journal, for both `--insecure` and secure-8192 fixtures.
- Local scripts run the unproved `dev` runner unless `CRISP_REAL_PROOFS=1`, and the image's default
  command is `openvm`. A green local round, or the `build_runner_image` smoke test (a stub worker),
  proves nothing about proving, keys, or the deployed verifier.

Start with `cargo test -p e3-user-program`; CI runs `cargo test` for the workspace. A change to
`program/`, `guest/` or `scripts/openvm.sh` also needs `pnpm openvm fixture 2 <new-dir>` (generates
fresh inputs, so use a new directory) then `pnpm openvm guest-parity <new-dir>`, which needs
`cargo-openvm` and the pinned nightly toolchain from the CI job; report either as skipped if absent.
`bash scripts/build-runner-image.sh` covers the Dockerfile. These checks do not produce a real
proof, rederive the app commitments, or exercise the Halo2 verifier; those need
`interfold program compile` with real workers and the `pnpm openvm contract-test` or `proof-test`
paths. See [proof aggregation](../docs/PROOF_AGGREGATION_AND_ZK.md) for the local proof modes.
