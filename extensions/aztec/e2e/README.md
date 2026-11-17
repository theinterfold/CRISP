# CRISP on Aztec: end-to-end round

One full round of the Aztec program on a local Aztec v6 network, with real components throughout:

1. deploys the Interfold + CRISP stack, `CRISPAztecProgram` (L1) and `CrispAztec` (L2, with the vendored ZKPassport
   registry), and binds the two;
2. starts five ciphernodes, the program server, the CRISP server (`PROGRAM_KIND=aztec`) and the keeper;
3. `Interfold.request`s an E3 with the Aztec program: the creator sends one transaction;
4. waits for the DKG (stage `KeyPublished`); the keeper opens the round and relays the key to L2;
5. registers four voters with real mock-document ZKPassport proofs, then casts four votes and adds one mask (a zero ballot on a slot that already voted: it must not change the tally)
   (`@crisp-e3/aztec`);
6. warps the network clock past the input window; the keeper closes the round and submits the root on L1;
7. the server computes, the ciphernodes decrypt, and the decoded tally must equal `[20, 20]` (voters 1-2 pick option 0, voters 3-4 option 1, ten credits each).

```sh
pnpm test:e2e:aztec           # up, round, down (down also on failure; CRISP_E2E_KEEP=1 leaves the stack up)
pnpm test:e2e:aztec:up        # deploy and start the services
pnpm test:e2e:aztec:round     # one round against a running stack (repeatable: each run is a new E3)
pnpm test:e2e:aztec:down      # stop everything and restore the repo files the deploy scripts rewrite
```

Logs of every service and deploy step are in `extensions/aztec/e2e/.work/logs/`, the state (addresses, pids) in
`.work/state.json`, and the result of a round (tally, every transaction hash) in `.work/report.json`.

## Prerequisites

- A running Aztec v6 local network (`aztec start --local-network`): node on `:8080`, anvil on `:8545` (chain 31337). The
  harness never starts or stops it, and never starts another anvil.
- `node` 24 and `pnpm` 10 on `PATH`, a Rust toolchain (the CRISP server and the program server are `cargo` builds), and
  `aztec-nr` artifacts at `extensions/aztec/contracts/target/` (`aztec compile`).
- Network access on first use: the interfold release assets (`scripts/interfold-release.mjs`), `bb`, and the ZKPassport
  circuit verification keys (`circuits2.zkpassport.id`).
- Free ports `4000` (CRISP server), `13151` (program server), `13415` (ciphernode supervisor), `8090` (dashboard).
- Several GB of free disk: Rust build artifacts, the Noir prover and the circuits archive.

## Accounts and ports

The local network's sequencer publishes to L1 from the default anvil mnemonic's index 0, so a second sender with that
account races its nonce. The harness never sends from it. Its own accounts come from the mnemonic
`legal winner thank year wave sausage worth useful legal winner thank yellow` (override with `CRISP_E2E_MNEMONIC`) and are
funded through `anvil_setBalance`:

| index | role |
| --- | --- |
| 0 | deployer, owner of Interfold and both programs, mints the fee token, bonds the ciphernodes |
| 1 | CRISP server key: availability signer and the server's L1 sender |
| 2 | poll creator: the one transaction of a round, `Interfold.request` |
| 3 | keeper's L1 gas payer |

The five ciphernodes use the anvil mnemonic's accounts 1-5 (as `scripts/dev_cipher.sh`); they are bonded and licensed
with the deployer's key. Voters' slot keys are random and need no funds.

## How it deviates from `scripts/dev.sh`, and why

- **Dashboard port 8090.** `interfold.config.yaml` gives the first ciphernode's dashboard port 8080, the Aztec node's.
  The harness writes its own config to `.work/interfold.config.yaml` and leaves the repo's alone.
- **Pinned release CLI, full proof aggregation.** The `interfold` binary of `interfold-release.json` is downloaded to
  `.work/bin/`. It is built without the test-only skip-aggregation feature, so the ciphernodes really aggregate their proofs
  and the Interfold stack is deployed with `ENABLE_ZK_VERIFICATION=true`. With your own binary that has the feature, set
  `INTERFOLD_BIN=<path> CRISP_E2E_SKIP_PROOF_AGGREGATION=true`.
- **Compute is the dev (unproved) program** (`E3_PROGRAM__DEV=true`, `CRISP_UNPROVED_TEST=1`, mock OpenVM receipt
  verifier): the repo's local default. Everything else, the fold proofs the voters generate, the ZKPassport proofs, the
  Aztec contract, the outbox witness, is real.
- **An idle local network builds no blocks**, so an L1→L2 message is never included, an epoch is never proven and time
  never moves. While a round runs, the harness asks the node's debug API for an empty block every 8s
  (`warpL2TimeAtLeastBy(1)`, `CRISP_E2E_PUMP_MS`). The keeper does not do this: on a real network blocks keep coming.
- **The clock is warped.** The ZKPassport registry seeding warps the network 24h (once, then persistent). `Interfold.request`
  requires the window to start after a worst-case key setup (2h), so the harness warps to `inputStart` once the key is in,
  and to `inputEnd` once the votes are in, instead of waiting. Chain time therefore runs ahead of wall-clock time.
- **Repo files are snapshotted and restored.** The deploy scripts rewrite `interfold.config.yaml`,
  `packages/crisp-contracts/deployed_contracts.json`, `extensions/aztec/l1/deployed_contracts.json`, `server/.env` and
  `client/.env`; `down` puts them back (or removes them if they did not exist).
- `E3_PARAM_SET=0` (insecure-64 BFV) and a 3-member committee (`E3_COMMITTEE_SIZE=0`): the dev preset.

## Knobs

`CRISP_E2E_VOTING_SECONDS` (3600), `CRISP_E2E_PUMP_MS` (8000), `CRISP_E2E_KEEPER_POLL_MS` (5000),
`CRISP_E2E_DKG_TIMEOUT_S` (1200), `CRISP_E2E_ROOT_TIMEOUT_S` (1500), `CRISP_E2E_COMPUTE_TIMEOUT_S` (1800),
`AZTEC_NODE_URL`, `L1_RPC_URL`, `CRISP_E2E_WORK`, `RUST_LOG`.
