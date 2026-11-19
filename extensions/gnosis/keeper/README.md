# CRISP Gnosis keeper

A service that takes the steps of a proposal nobody else has a reason to take. All of them are permissionless; the
keeper only needs a funded account on Sepolia and on Chiado (they may be the same key).

For every proposal the Sepolia program announced (`ProposalCreated`), it does what is due, read from chain state:

| Step              | When                                                                  | Effect                                                                               |
| ----------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `relayKey`        | Interfold published the key, the program has not sent it              | Sepolia `publishCommitteeKey` (KEY goes over the AMB)                                |
| `closeRound`      | the window ended on Chiado, ballots exist, the round is not closed    | Chiado `closeRound` (ROOT goes into the Home AMB)                                    |
| `deliverRoot`     | the round is closed, the program has no root                          | AMB Helper `getSignatures` → Sepolia Foreign AMB `executeSignatures`                 |
| `relayResult`     | Interfold completed the E3, the program has not sent the result       | Sepolia `relayResult` (RESULT goes over the AMB)                                     |
| `executeProposal` | with a module: the result passes quorum and approval, not yet queued  | Chiado `CrispGovernanceModule.executeProposal(roundId, packed)`                      |
| Delay queue       | with a module: the Delay's next entry is past its cooldown, unexpired | Chiado `Delay.executeNextTx(...)` with the arguments of its `TransactionAdded` log   |

State is never kept on disk: every pass re-reads both chains, so a restart, or a second keeper, repeats nothing. A step
that fails (signatures not yet available, a message still in flight) is retried on the next pass. A round is finished
when Interfold failed it, its result arrived (without a module), or its proposal was queued or can never pass (with one).

## Run

```bash
pnpm -C extensions/gnosis/sdk build && pnpm -C extensions/gnosis/keeper build

KEEPER_SEPOLIA_RPC_URL=… KEEPER_SEPOLIA_PRIVATE_KEY=0x… \
KEEPER_CHIADO_RPC_URL=… KEEPER_CHIADO_PRIVATE_KEY=0x… \
CRISP_GNOSIS_PROGRAM=0x… CRISP_GNOSIS_VOTING=0x… KEEPER_AMB_HELPER=0x… \
pnpm -C extensions/gnosis/keeper start
```

`KEEPER_AMB_HELPER` is `0x3cc500B3c01D04C265c9293cB35BA2Fd8eA6dc1b` on Chiado. Optional: `CRISP_GOVERNANCE_MODULE` plus
`KEEPER_METADATA_URL` (a URL with `{cid}`; it returns the proposal's JSON, whose `packedTransactions` is the batch the
module executes) to also execute passed proposals and the Delay's queue; `KEEPER_START_BLOCK_SEPOLIA` /
`KEEPER_START_BLOCK_CHIADO` (default `0`: set the deployment blocks on a public network); `KEEPER_POLL_INTERVAL_MS`
(default `10000`).

## Things that are not obvious

- **Nobody else delivers ROOT.** Chiado→Sepolia messages need `getSignatures` + `executeSignatures`; without a keeper the
  E3 times out.
- **A poisoned Delay entry blocks the queue.** A queued call that reverts makes `executeNextTx` revert without advancing;
  the Safe's owners clear it with `Delay.setTxNonce`.
- **The Chiado clock decides when a round can close,** not the Sepolia one.
