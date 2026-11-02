# Working on CRISP contracts

`contracts/CRISPProgram.sol` owns round, census, input-tree, and tally rules; `deploy/` and
`scripts/` adapt it and the pinned Interfold protocol contracts. [README.md](README.md) owns the
program description and deploy usage, and [RELEASING.md](../../RELEASING.md) owns publishing.

- ABI, events, and encodings have no generated bindings. The server's `sol!` blocks in
  `crates/evm_helpers/src/lib.rs`, the SDK's `parseAbi` reads and input envelope, the server's
  seven-field round parameters and `CensusMode` discriminants, the EIP-712 type hashes, and the
  input-leaf layout (`program/tests/input_leaf.rs`) are hand-written copies; change them together.
  `artifacts/` and `types/` are ignored build output.
- `contracts/verifiers/*.sol` are tracked, generated, and patched by `scripts/compile_circuits.sh`;
  never hand-edit them. They are per census mode, not per preset, and both declare `HonkVerifier`,
  so look them up through `scripts/verifiers.ts`. New verifier bytes mean a redeploy. Interfold
  contracts deployed here compile only if `hardhat.config.ts` lists them in `npmFilesToBuild`.
- Deploy switches decide what is real. `USE_MOCKS` selects a mock voting token and the mock
  data-availability verifier (unless `MOCK_DATA_AVAILABILITY=false`) but never the compute verifier.
  `CRISP_UNPROVED_TEST=1` deploys a verifier that accepts every receipt, only on chain 31337 or on
  Sepolia with `ALLOW_SEPOLIA_UNPROVED_COMPUTE=true`; `scripts/crisp_deploy.sh` sets it unless
  `CRISP_REAL_PROOFS=1`. `DEFER_PROTOCOL_WIRING` skips verifier, registration, and bind steps, so
  CRISP stays unusable until governance wires it. Keep the mainnet guards.
- `deployed_contracts.json` is tracked and rewritten by deploy and `clean:deployments`; its
  `localhost` section churns on every local deploy. The server embeds it with `include_str!`, and
  `test/crisp.spec.ts`, `scripts/anvil-randomness.mjs`, and the `upgrade:v19` step in
  [RELEASING.md](../../RELEASING.md) read it. Do not hand-edit recorded `mainnet`/`sepolia`
  addresses or commit local churn.
- `tests/fixtures/input-tree*.json` come from `UPDATE_INPUT_TREE_FIXTURE=1` on
  `tests/input-tree-e2e.test.ts` and are asserted by `program/tests/onchain_root_agreement.rs`;
  after a refresh run `cargo test -p e3-user-program`. Name each test file in exactly one CI leg in
  `package.json`, or CI never runs it.
- `@crisp-e3/contracts` and `@crisp-e3/sdk` publish as a matched pair through `scripts/publish.ts`;
  a contract change the SDK relies on needs a coordinated release.

From this package, `pnpm check:test-legs`, `pnpm compile`, and `pnpm test:unit` are the smallest
checks. Add `test:ballots:program`, `test:ballots:census`, or `test:input-tree` for ballot, census,
or input-tree changes; root `pnpm test:contracts:*` runs the same legs CI does. Deploy or verifier
changes need the root `pnpm test:e2e`. Unit tests use mock Interfold, compute, and availability
contracts, so none of this proves real OpenVM receipt acceptance, Avail finalization, or Sepolia or
mainnet governance wiring.
