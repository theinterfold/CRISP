# CRISP on Gnosis: end-to-end proposal

One full proposal on a local anvil, with real components throughout except the bridge: the Interfold stack, five
ciphernodes, the program server, the CRISP server (`PROGRAM_KIND=gnosis`), the keeper, the Gnosis contracts and a Safe
with the Zodiac Delay and `CrispGovernanceModule`. One anvil plays Sepolia and Chiado, and two `MockAMB` deployments
connect them: `src/relayer.ts` delivers Foreign→Home messages (ROUND, KEY, RESULT) as the AMB validators do, and the keeper
carries the Home→Foreign ROOT with `getSignatures` + `executeSignatures`, as it does on the real AMB.

The round:

1. three voters claim tokens from the server's faucet (gasless, self-delegated);
2. the proposer requests a round for a Safe batch (`token.transfer(recipient, amount)`), bound by `proposalHash`, with the
   batch in metadata the keeper fetches from `src/metadata.ts`;
3. ROUND reaches the voting contract, the DKG finishes, the keeper relays KEY;
4. two voters vote For, one Against (EIP-712 signature, real fold proofs), and a mask is added to the Against voter's slot;
5. the chain clock moves past the window; the keeper closes the round and delivers ROOT; the server computes, the
   ciphernodes decrypt, the keeper relays the RESULT, and the tally must be `[w1 + w2, w3, 0]`;
6. the keeper queues the proposal in the Delay (`executeProposal`), the clock moves past the cooldown, the keeper runs
   `executeNextTx`; the Safe's token balance must have fallen by the batch amount.

```sh
pnpm -C extensions/gnosis/e2e e2e all     # up, round, down (down also on failure; CRISP_E2E_KEEP=1 leaves the stack up)
pnpm -C extensions/gnosis/e2e e2e up      # start anvil, deploy, start the services
pnpm -C extensions/gnosis/e2e e2e round   # a proposal against a running stack (repeatable)
pnpm -C extensions/gnosis/e2e e2e down    # stop everything and restore the repo files the deploy scripts rewrite
```

Logs of every service and deploy step are in `.work/logs/`, the state in `.work/state.json`, the result in
`.work/report.json`.

## Prerequisites

`node` 24, `pnpm` 10, a Rust toolchain (the CRISP server is a `cargo` build), Foundry (`anvil`, `forge`), network access on
first use (the interfold release assets). Free ports `8545` (anvil), `4000`, `4010`, `13151`, `13415`, `8090`. Accounts come
from `CRISP_E2E_MNEMONIC` and are funded with `anvil_setBalance`; the ciphernodes use anvil's default accounts 1-5.

The harness follows `extensions/aztec/e2e`: pinned release CLI, the dev (unproved) compute program, `E3_PARAM_SET=0` and a
three-member committee. The chain clock is moved with `evm_increaseTime`, not waited for: the window opens after a
worst-case key setup, and the Delay has a cooldown. Knobs: `CRISP_E2E_VOTING_SECONDS` (3600, the program's minimum),
`CRISP_E2E_DKG_TIMEOUT_S`, `CRISP_E2E_RESULT_TIMEOUT_S`, `CRISP_E2E_KEEPER_POLL_MS`, `CRISP_E2E_SKIP_PROOF_AGGREGATION`, `CRISP_E2E_DIRECT_FAUCET=1` (mint the voters' tokens with the faucet key: the server rate-limits `/faucet`, so a second `round` on the same stack needs it).
