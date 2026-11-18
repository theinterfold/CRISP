# CRISP on Aztec: L1 program

`CRISPAztecProgram` is the Interfold E3 program for rounds whose ballots are cast on Aztec
(`../contracts`). It is `CRISPRemoteProgram` (see [`../../core`](../../core/README.md)) plus the
Aztec Inbox/Outbox transport. Voters register on Aztec. The poll creator makes one L1 transaction (`Interfold.request`);
everything else is a permissionless call that a keeper makes.

```
Interfold.request ─ validate ──ROUND──▶ Inbox ─▶ crisp_aztec.open_round (L2)
Interfold key published ─ publishCommitteeKey ──KEY──▶ Inbox ─▶ crisp_aztec.publish_key
                              ballots and registrations on L2 (SponsoredFPC pays)
crisp_aztec.close_round ──ROOT──▶ Outbox ─ submitInputRoot ─▶ verify(root)
```

## Things that are not obvious

- **Deployment order is circular.** `crisp_aztec` takes this program's address as an immutable, and
  this program takes the L2 address afterwards through `setL2Program` (owner, once). `validate`
  reverts with `L2ProgramNotSet` until then, so no round can be requested against an unwired
  program.
- **L1 → L2 messages carry a constant secret hash**, the hash of secret `0`. The L2 consumes them in
  a public function that anyone may call; the content authenticates them because only this program
  can make the Inbox record it as the sender. The constant is pinned in `SECRET_HASH` and was
  computed once with aztec.js 6.0.0, from any package that depends on `@aztec-labs/aztec.js`:

  ```js
  import { Fr } from '@aztec-labs/aztec.js/fields'
  import { computeSecretHash } from '@aztec-labs/aztec.js/crypto'
  console.log((await computeSecretHash(Fr.ZERO)).toString()) // 0x1f8eff65…d2250
  ```

- **Message contents** are `sha256ToField(abi.encode(...))`: the first 31 bytes of the sha256, as a
  field. `tests/fixtures/message-vectors.json` holds the ROUND (12 words; `round` carries a nationality
  commitment, `roundNoRule` has no nationality rule), KEY and ROOT bytes and contents the
  L2 contract and the SDK assert against (`node scripts/generate-message-vectors.mjs` regenerates it). Word 2 of
  every message is the `roundId` (the low 96 bits of the E3 id, see `remoteRoundId`/`e3IdOf`): a real
  Interfold E3 id is `interfold << 96 | sequence`, above the BN254 modulus. The scope a ZKPassport proof binds to is
  `crisp-aztec:<chainId>:<lowercase program address>:<e3Id>`, hashed as
  `uint256(sha256(scope)) >> 8` (`scopeOf`, `scopeHashOf`).
- **`submitInputRoot` takes an Outbox witness** (`epoch`, `numCheckpointsInEpoch`, `leafIndex`,
  `path`), the same values `getL2ToL1MembershipWitness` returns for the `close_round` transaction.
  The Outbox only lets the message's recipient consume it and pins its sender to `l2Program`; the
  root and the count are bound by the message content. `Epoch` is a plain `uint256` in the ABI.
- **`publishCommitteeKey` only works while the E3 is in `KeyPublished`.** The key is useless to the
  L2 afterwards, and the ROOT is likewise refused once the round has left that stage.
- **Rounds are bounded at 65,536 inputs** (L2 gas, not BFV noise); the limit sent to the L2 is
  `min(65536, (t - 1) / credits)`.
- **`minVotingDuration` is the timing switch.** Zero (local network) skips the key-deadline and
  one-hour checks; anything else must be at least one hour. Sepolia deploys with one hour.
- **`remoteFinalityWindow` is the tail between the end of voting and a deliverable root.** Interfold
  derives the compute deadline from the end of the input window, and the root can only be submitted
  after Aztec has closed the round and an epoch proof containing it reached the Outbox. `validate`
  reverts `ComputeWindowTooShort` when Interfold's compute window is shorter, so the requester fails
  before paying instead of timing out afterwards. Deploy default: 10800 s on Sepolia (two
  epoch-proof windows plus margin), 0 locally; override with `CRISP_REMOTE_FINALITY_WINDOW`.
  `minAge` is at most 99 (ZKPassport's `age_min` asserts `min < 100`).
- The ABI the SDK, keeper and server read is tracked at `abi/CRISPAztecProgram.json`; regenerate it with
  `pnpm export:abi` after any contract change (a test fails on drift).

## Commands

```bash
pnpm test               # unit tests: real Aztec Inbox and Outbox bytecode (v6.0.0) + test doubles for Interfold/OpenVM/DA
pnpm check:network      # needs `aztec start --local-network`: sends ROUND and KEY through the live Inbox
pnpm deploy:localhost   # CRISPAztecProgram next to the Interfold + CRISP stack already on the local anvil
pnpm deploy:sepolia     # Aztec testnet bridge, Interfold + CRISP from packages/crisp-contracts/deployed_contracts.json
```

`pnpm test` deploys the compiled `Inbox` and `Outbox` from `@aztec-foundation/l1-artifacts` and
builds Outbox witnesses with the real merkle rules, so message hashing, version, recipient and
nullifier behaviour are the protocol's. It does not prove an Aztec rollup proof or a real L2
`close_round`; the end-to-end run does.

### Deploy

`deploy/deploy.ts` reads the Interfold, OpenVM receipt verifier and data-availability verifier
recorded by the CRISP deploy (`pnpm deploy:contracts` in `packages/crisp-contracts`) in
`packages/crisp-contracts/deployed_contracts.json`, deploys the program, registers it with Interfold
and binds it, as the CRISP deploy does for `CRISPProgram`. Run the CRISP deploy first. See the
header of the script for the environment variables.
Local flow:

```bash
pnpm deploy:localhost                              # prints CRISP_AZTEC_L1_PROGRAM
# deploy crisp_aztec with that L1 address, then:
CRISP_AZTEC_L2_ADDRESS=0x… pnpm deploy:localhost   # reuses the program, sets l2Program
```

The local Inbox, Outbox and rollup version are read from the Aztec node (`AZTEC_NODE_URL`, default
`http://localhost:8080`) because a local network picks new ones on every start. Sepolia uses the
Aztec testnet bridge (Inbox `0x7cdC32Dd7d008870A95f1837Ffd7229ef676EF8A`, Outbox
`0xA5A0f7a7BDAf280964a1922A68C83462E5F6E15b`, rollup version `679261766`); the constructor refuses
them unless both contracts report that version.

Governance-owned Interfold deployments need their owner to call `registerE3Program(program)` and
then the program owner `bindInterfold(interfold)`; the script prints that instead of failing.
Addresses are recorded in `deployed_contracts.json` here; do not commit the `localhost` entry.
