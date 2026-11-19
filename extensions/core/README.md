# CRISP extensions: core

Chain-agnostic L1 contracts for CRISP rounds whose ballots are collected on another chain (an L2). Interfold only talks to L1, so
an L1 E3 program stays the contract Interfold sees, and the L2 plays the role `CRISPProgram`'s input tree plays today.

`CRISPRemoteProgram` is that program minus the transport. It reuses `CRISPProgram`'s OpenVM journal and `verify` rule, its output
data availability, tally decoding and ERC-165 surface, and its timing and credit rules. It has no input tree and `publishInput`
always reverts.

## What an L2 adapter provides

| Hook                                                         | Contract                                                                                                                                         |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `_sendToRemote(e3Id, message) returns (content)`             | Deliver one of the `CRISPRemoteMessages` layouts to the remote CRISP contract. Called inside `validate` (ROUND) and `publishCommitteeKey` (KEY). |
| `scopeOf(e3Id)`                                              | The string a voter's identity proof is bound to. Unique per program, chain and round.                                                            |
| an entry point calling `_acceptInputRoot(e3Id, root, count)` | Authenticate the ROOT message through the L2's own bridge first. Everything the base needs is the root and the count.                            |

`CRISPAztecProgram` (`extensions/aztec/l1`) is the reference implementation. A new L2 adds a sibling under `extensions/<l2>/`,
imports `@crisp-e3/extension-core/contracts/CRISPRemoteProgram.sol`, and implements the three hooks.

## Round rules

A round's custom parameters are `abi.encode(numOptions, credits, minAge, allowMockDocuments, nationalityMode, countries,
nationalityCommitment)` (see `aztec/README.md`). With a nationality rule the L2 checks ZKPassport's Poseidon2 commitment of the country
list, which L1 cannot recompute: `nationalityCommitment` must be a non-zero field element (0 without a rule), and a wrong one only
makes the poll unregistrable, so apps recompute it from `RoundRules` and refuse a mismatch. `validate` emits `RoundRules(...)`, the
one place a client reads the list a round was created with.

## Invariants every adapter inherits

- **The remote chain knows a round by `roundId = e3Id & (2^96 - 1)`.** `e3Id = uint160(interfold) << 96 | sequence` does not fit
  the field element most L2s use for an id. Word 2 of the ROUND, KEY and ROOT messages is the `roundId` (`remoteRoundId(e3Id)`;
  `e3IdOf(roundId)` inverts it); `validate` refuses an E3 id that does not carry the bound Interfold's address
  (`E3NotOfBoundInterfold`). Events, the scope string and every L1 / server digest keep the full E3 id.
- **The L2 tree must equal `CRISPProgram`'s tree** (leaves, zk-kit lazy IMT with circom Poseidon, dynamic root depth), because the
  compute side is shared. `inputLimit` is capped at `MAX_INPUTS_PER_ROUND` (65,536 leaves) because an L2 insert recomputes up to 16
  hashes per transaction.
- **A root is accepted once, while the E3 is in `KeyPublished`, and never zero.** `verify` rejects a compute proof whose
  `inputRoot` is not the delivered root.
- **Message layouts are a protocol.** `CRISPRemoteMessages` fixes them as 32-byte ABI words with the message kind first (ROUND has
  12 words). The L2 contract and every off-chain encoder copy them by hand; a change is a cross-component change. The Aztec byte
  vectors live in `extensions/aztec/l1/tests/fixtures/message-vectors.json`.
- **`minVotingDuration` of zero turns off the timing checks** (local networks only).
- **`remoteFinalityWindow` guards the compute deadline.** Interfold's compute deadline counts from the end of the input window, but
  the remote root only becomes deliverable after the L2 closes the round and settles. `validate` reverts `ComputeWindowTooShort` if
  Interfold's compute window is shorter than this adapter-chosen tail (zero disables it).

## Staging pass (`circuits/staging_pass`)

The CRISP server of a remote round stages a ciphertext and signs the availability attestation **before** the `cast`; the pass is a
chain-agnostic Noir circuit that gates this by proving "I hold the key of SOME slot registered in this round's census" plus a
one-time rate-limit tag (`tag = Poseidon(x_hi, x_lo, y_hi, y_lo, round_id, k)`, `k < max_requests`), revealing neither slot nor key.
The census leaf `Poseidon2(slot, credits)` and the LeanIMT path are `crisp_lib`'s. The tag hashes the slot **public key**, never the
address, so tags are unlinkable to slots as long as the key stays unpublished. The server side is in `extensions/aztec/README.md`
("Staging pass"), the prover in `extensions/aztec/sdk` (`buildStagingPass`).

`circuits/staging_pass/build.sh` compiles it (`nargo` 1.0.0-rc.3, as `circuits/`) and writes `compiled/staging_pass.json` (the SDK
loads it) and `compiled/staging_pass.vk` (the server loads it; the Docker image ships it) for bb 6.0.0's default `evm` target. Both
are checked in: **rerun the script whenever `circuits/lib` or the circuit changes, or the server rejects every pass.** `nargo test`
in the circuit directory runs its tests.
