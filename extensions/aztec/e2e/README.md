# CRISP on Aztec: end-to-end round

One full round of the Aztec program on a local Aztec v6 network, with real components throughout: it deploys the Interfold + CRISP
stack, `CRISPAztecProgram` (L1) and `CrispAztec` (L2, with the vendored ZKPassport registry); starts five ciphernodes, the program
server, the CRISP server (`PROGRAM_KIND=aztec`) and the keeper; runs `Interfold.request` and the DKG; registers four voters with real
mock-document ZKPassport proofs (age 18+, nationality in `[ZKR, DEU]`: `outer_count_6`); casts four votes and one mask (a zero ballot on
a slot that already voted, which must not change the tally) and checks that two tampered ballots (an altered ct1 commitment, the ct0 and
ct1 proofs swapped) are refused where the transaction is proven; warps the clock past the input window, lets the keeper close the round
and submit the root, and checks that the decoded tally equals `[20, 20]` (voters 1-2 pick option 0, voters 3-4 option 1, ten credits
each).

```sh
pnpm test:e2e:aztec           # up, round, down (down also on failure; CRISP_E2E_KEEP=1 leaves the stack up)
pnpm test:e2e:aztec:up        # deploy and start the services
pnpm test:e2e:aztec:round     # a round against a running stack (repeatable: each run is new E3s)
pnpm test:e2e:aztec:down      # stop everything and restore the repo files the deploy scripts rewrite
```

Logs of every service and deploy step are in `extensions/aztec/e2e/.work/logs/`, the state (addresses, pids) in `.work/state.json`,
and the result of the round (tally, every transaction hash) in `.work/report.json`. The ZKPassport mock-proof tooling is in
[`zkpassport/`](zkpassport/README.md).

## Prerequisites

- A running Aztec v6 local network (`aztec start --local-network`): node on `:8080`, anvil on `:8545` (chain 31337). The harness
  never starts or stops it, and never starts another anvil.
- `node` 24, `pnpm` 10, a Rust toolchain, and `aztec-nr` artifacts at `extensions/aztec/contracts/target/` (`aztec compile`).
- Network access on first use (interfold release assets, `bb`, `circuits2.zkpassport.id`), free ports `4000`, `13151`, `13415`,
  `8090`, and several GB of disk.

## Accounts

The local network's sequencer publishes to L1 from the default anvil mnemonic's index 0, so the harness never sends from it (a second
sender would race its nonce). Its own accounts come from the mnemonic `legal winner thank year wave sausage worth useful legal
winner thank yellow` (override with `CRISP_E2E_MNEMONIC`), funded through `anvil_setBalance`: 0 deployer, 1 CRISP server key,
2 poll creator, 3 keeper. The ciphernodes use the anvil mnemonic's accounts 1-5.

## How it deviates from `scripts/dev.sh`

- **Dashboard port 8090** (the repo config's 8080 is the Aztec node's); the harness writes its own config to
  `.work/interfold.config.yaml`.
- **Pinned release CLI, full proof aggregation** (`ENABLE_ZK_VERIFICATION=true`). With your own binary built with the test-only
  skip-aggregation feature, set `INTERFOLD_BIN=<path> CRISP_E2E_SKIP_PROOF_AGGREGATION=true`.
- **Compute is the dev (unproved) program** (`E3_PROGRAM__DEV=true`, `CRISP_UNPROVED_TEST=1`, mock OpenVM receipt verifier); the
  voters' base proofs, the ZKPassport proofs, the Aztec contract and the outbox witness are real.
- **An idle local network builds no blocks**, so L1→L2 messages are never included. While a round runs, the harness asks the node's
  debug API for an empty block every 8s (`warpL2TimeAtLeastBy(1)`, `CRISP_E2E_PUMP_MS`).
- **The clock is warped**: 24h once by the ZKPassport registry seeding, then to `inputStart` and to `inputEnd`. Chain time runs
  ahead of wall-clock time.
- **Repo files are snapshotted and restored.** The deploy scripts rewrite `interfold.config.yaml`,
  `packages/crisp-contracts/deployed_contracts.json`, `extensions/aztec/l1/deployed_contracts.json`, `server/.env` and
  `client/.env`; `down` puts them back.
- `E3_PARAM_SET=0` (insecure-64 BFV) and a 3-member committee (`E3_COMMITTEE_SIZE=0`): the dev preset.

## Knobs

`CRISP_E2E_VOTING_SECONDS` (3600), `CRISP_E2E_PUMP_MS` (8000), `CRISP_E2E_KEEPER_POLL_MS` (5000), `CRISP_E2E_DKG_TIMEOUT_S` (1200),
`CRISP_E2E_MEMBERS_TIMEOUT_S` (1200, registration), `CRISP_E2E_ROOT_TIMEOUT_S` (1500), `CRISP_E2E_COMPUTE_TIMEOUT_S` (1800),
`AZTEC_NODE_URL`, `L1_RPC_URL`, `CRISP_E2E_WORK`, `RUST_LOG`.
