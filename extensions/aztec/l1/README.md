# CRISP on Aztec: L1 program

`CRISPAztecProgram` is the Interfold E3 program for rounds whose ballots are cast on Aztec (`../contracts`). It is
`CRISPRemoteProgram` (see [`../../core`](../../core/README.md)) plus the Aztec Inbox/Outbox transport. The poll creator makes one
L1 transaction (`Interfold.request`); everything else is a permissionless call that a keeper makes.

```
Interfold.request ─ validate ──ROUND──▶ Inbox ─▶ crisp_aztec.open_round (L2)
Interfold key published ─ publishCommitteeKey ──KEY──▶ Inbox ─▶ crisp_aztec.publish_key
                              ballots and registrations on L2 (SponsoredFPC pays)
crisp_aztec.close_round ──ROOT──▶ Outbox ─ submitInputRoot ─▶ verify(root)
```

## Things that are not obvious

- **Deployment order is circular.** `crisp_aztec` takes this program's address as an immutable, and this program takes the L2
  address afterwards through `setL2Program` (owner, once). `validate` reverts with `L2ProgramNotSet` until then.
- **L1 → L2 messages carry a constant secret hash** (the hash of secret `0`, pinned in `SECRET_HASH`): the L2 consumes them in a
  public function anyone may call, and the sender (this program) authenticates them. Recompute it with aztec.js 6.0.0:

  ```js
  import { Fr } from '@aztec-labs/aztec.js/fields'
  import { computeSecretHash } from '@aztec-labs/aztec.js/crypto'
  console.log((await computeSecretHash(Fr.ZERO)).toString()) // 0x1f8eff65…d2250
  ```

- **Message contents** are `sha256ToField(abi.encode(...))` (first 31 bytes of the sha256); word 2 is the `roundId`.
  `tests/fixtures/message-vectors.json` holds the bytes and contents the L2 contract and the SDK assert against
  (`node scripts/generate-message-vectors.mjs` regenerates it). The scope a ZKPassport proof binds to is
  `crisp-aztec:<chainId>:<lowercase program address>:<e3Id>`, hashed as `uint256(sha256(scope)) >> 8` (`scopeOf`, `scopeHashOf`).
- **`submitInputRoot` takes an Outbox witness** (`epoch`, `numCheckpointsInEpoch`, `leafIndex`, `path`), the values
  `getL2ToL1MembershipWitness` returns for the `close_round` transaction. The Outbox only lets the message's recipient consume it
  and pins its sender to `l2Program`.
- **`publishCommitteeKey` and the ROOT are only accepted while the E3 is in `KeyPublished`.**
- **Rounds are bounded at 65,536 inputs** (L2 gas); the limit sent to the L2 is `min(65536, (t - 1) / credits)`. `minAge` is at
  most 99.
- **`minVotingDuration`**: zero (local network) skips the key-deadline and one-hour checks; otherwise at least one hour.
- **`remoteFinalityWindow`** is the tail between the end of voting and a deliverable root (Aztec must close the round and an epoch
  proof containing it must reach the Outbox); `validate` reverts `ComputeWindowTooShort` when Interfold's compute window is
  shorter. Deploy default: 10800 s on Sepolia, 0 locally; override with `CRISP_REMOTE_FINALITY_WINDOW`.
- The ABIs the SDK, keeper and server read are tracked at `abi/CRISPAztecProgram.json` and `abi/CRISPAztecVotesProgram.json`; regenerate them with `pnpm export:abi` after
  any contract change (a test fails on drift).

## Token-weighted votes: `CRISPAztecVotesProgram`

Both programs extend `CRISPAztecTransport` (Inbox/Outbox bridge, `setL2Program`, `submitInputRoot`). `CRISPAztecVotesProgram`
runs the Interfold governance's token-weighted rounds against `crisp_aztec_votes`:

- `customParams` are `CRISPProgram`'s seven fields; only `creditMode` CUSTOM (1), `credits` 0 and `censusMode` ONCHAIN (2) are
  accepted. Snapshot, divisor and floor rule are those of `CRISPProgram`; `weightOf(e3Id, slot)` is `getPastVotes / divisor`, zero
  below the floor.
- Messages: ROUND `abi.encode(1, roundId, numOptions, inputStart, inputEnd, inputLimit)`;
  ENROLL `abi.encode(4, roundId, uint256(uint160(slot)), weight)`; KEY and ROOT as in `CRISPRemoteMessages`.
- `enroll(e3Id, slots)` is permissionless: it reads each slot's weight from the token itself, skips enrolled and below-floor slots,
  sends ENROLL and emits `Enrolled(e3Id, slot, weight, leaf)`, where `leaf` is the Inbox leaf the Aztec `enroll` consumes. It
  reverts for an unknown E3 and once the input window ended.

Deploy it with `CRISP_AZTEC_KIND=votes pnpm deploy:localhost` (or `deploy:sepolia`); the deployment is recorded as
`CRISPAztecVotesProgram`.

## Commands

```bash
pnpm test               # unit tests: real Aztec Inbox and Outbox bytecode (v6.0.0) + test doubles for Interfold/OpenVM/DA
pnpm check:network      # needs `aztec start --local-network`: sends ROUND and KEY through the live Inbox
pnpm deploy:localhost   # CRISPAztecProgram (CRISP_AZTEC_KIND=votes: CRISPAztecVotesProgram) next to the Interfold + CRISP stack already on the local anvil
pnpm deploy:sepolia     # Aztec testnet bridge, Interfold + CRISP from packages/crisp-contracts/deployed_contracts.json
```

### Deploy

`deploy/deploy.ts` reads the Interfold, OpenVM receipt verifier and data-availability verifier recorded by the CRISP deploy
(`pnpm deploy:contracts` in `packages/crisp-contracts`, run it first) in `packages/crisp-contracts/deployed_contracts.json`,
deploys the program, registers it with Interfold and binds it. See the header of the script for the environment variables. Local
flow:

```bash
pnpm deploy:localhost                              # prints CRISP_AZTEC_L1_PROGRAM
# deploy crisp_aztec with that L1 address, then:
CRISP_AZTEC_L2_ADDRESS=0x… pnpm deploy:localhost   # reuses the program, sets l2Program
```

The local Inbox, Outbox and rollup version are read from the Aztec node (`AZTEC_NODE_URL`, default `http://localhost:8080`). Sepolia
uses the Aztec testnet bridge (Inbox `0x7cdC32Dd7d008870A95f1837Ffd7229ef676EF8A`, Outbox
`0xA5A0f7a7BDAf280964a1922A68C83462E5F6E15b`, rollup version `679261766`); the constructor refuses them unless both report that
version.

On Sepolia, `SEPOLIA_GAS_PRICE` (wei) sets a fixed gas price for every transaction of the deploy. Without it ethers adds a 1 gwei
tip, which can cost far more than Sepolia's base fee justifies.

Governance-owned Interfold deployments need their owner to call `registerE3Program(program)` and then the program owner
`bindInterfold(interfold)`; the script prints that. Do not commit the `localhost` entry of `deployed_contracts.json`.
