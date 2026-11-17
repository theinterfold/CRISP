# CRISP Aztec keeper

A service that takes the steps of an Aztec round nobody else has a reason to take. All of them are
permissionless; the keeper only needs an L1 account with gas and an Aztec node. Fees on Aztec are
paid by the SponsoredFPC.

For every round the L1 program announced (`RoundConfigSent`), it does what is due, read from chain
state:

| Step         | When                                                         | Effect                                            |
| ------------ | ------------------------------------------------------------ | ------------------------------------------------- |
| `openRound`  | the round is not open on Aztec                               | consumes the ROUND message (`open_round`)         |
| `relayKey`   | Interfold published the key, the program has not relayed it  | L1 `publishCommitteeKey`                          |
| `publishKey` | the key was relayed, Aztec has not consumed it               | consumes the KEY message (`publish_key`)          |
| `closeRound` | the input window has ended on Aztec, the round is not closed | `close_round`, which sends the root to the Outbox |
| `submitRoot` | the round is closed, L1 has no root                          | L1 `submitInputRoot` with the Outbox witness      |

State is never kept on disk: every pass re-reads L1 and the Aztec logs, so a restart, or a second
keeper, repeats nothing. A step that fails (a message not yet in a block, a witness not yet on L1)
is retried on the next pass.

## Run

```bash
pnpm -C extensions/aztec/sdk build && pnpm -C extensions/aztec/keeper build

AZTEC_NODE_URL=http://localhost:8080 \
L1_RPC_URL=http://localhost:8545 \
KEEPER_L1_PRIVATE_KEY=0x… \
CRISP_AZTEC_PROGRAM=0x… \
CRISP_AZTEC_CONTRACT=0x… \
pnpm -C extensions/aztec/keeper start
```

`CRISP_AZTEC_PROGRAM` is `CRISPAztecProgram` on L1 and `CRISP_AZTEC_CONTRACT` is `crisp_aztec` on
Aztec. `KEEPER_START_BLOCK` (default `0`) is the first L1 block to look for rounds in: set it to the
program's deployment block on a public network. `KEEPER_POLL_INTERVAL_MS` defaults to `10000`.

## Things that are not obvious

- **The keeper works with full e3Ids** (what L1 events carry) and lets the SDK convert them to the
  96-bit round ids the Aztec contract and the bridge messages use.
- **An idle local network never includes L1→L2 messages.** It builds a block only when there is a
  transaction, so `openRound` and `publishKey` time out until something else is sent to the network.
- **`submitRoot` waits for the rollup.** The Outbox has the root only after the epoch containing
  `close_round` is proven on L1; the keeper logs that it is waiting and tries again.
- **The Aztec clock decides when a round can close,** not the L1 one: `close_round` reverts until an
  Aztec block's timestamp reaches `inputEnd`.
