# CRISP extensions: core

Chain-agnostic L1 contracts for CRISP rounds whose ballots are collected on another chain (an L2).
Interfold only talks to L1, so an L1 E3 program stays the contract Interfold sees, and the L2 plays
the role `CRISPProgram`'s input tree plays today.

`CRISPRemoteProgram` is that program minus the transport. It reuses `CRISPProgram`'s OpenVM journal
and `verify` rule, its output data availability, tally decoding and ERC-165 surface, and its timing
and credit rules (without the availability-finalization tail, which only exists for L1 ciphertext
receipts). It has no input tree and `publishInput` always reverts.

## What an L2 adapter provides

| Hook                                                         | Contract                                                                                                                                         |
| ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `_sendToRemote(e3Id, message) returns (content)`             | Deliver one of the `CRISPRemoteMessages` layouts to the remote CRISP contract. Called inside `validate` (ROUND) and `publishCommitteeKey` (KEY). |
| `scopeOf(e3Id)`                                              | The string a voter's identity proof is bound to. Unique per program, chain and round.                                                            |
| an entry point calling `_acceptInputRoot(e3Id, root, count)` | Authenticate the ROOT message through the L2's own bridge first. Everything the base needs is the root and the count.                            |

`CRISPAztecProgram` (`extensions/aztec/l1`) is the reference implementation. A new L2 adds a sibling
under `extensions/<l2>/`, imports `@crisp-e3/extension-core/contracts/CRISPRemoteProgram.sol`, and
implements the three hooks.

## Invariants every adapter inherits

- **The remote chain knows a round by `roundId = e3Id & (2^96 - 1)`, not by its E3 id.** Interfold issues
  `e3Id = uint160(interfold) << 96 | sequence`, about 2^256, which does not fit the field element most
  L2s use for an id. Word 2 of the ROUND, KEY and ROOT messages is the `roundId` (`remoteRoundId(e3Id)`;
  `e3IdOf(roundId)` inverts it). That is unambiguous because a remote contract serves one program and a
  program one Interfold, and `validate` refuses an E3 id that does not carry the bound Interfold's address
  (`E3NotOfBoundInterfold`). Events, the scope string and every L1 / server digest keep the full E3 id.
- **The L2 tree must equal `CRISPProgram`'s tree.** The compute side (OpenVM guest, program server)
  is shared, so leaves, the zk-kit lazy IMT with circom Poseidon, and its dynamic root depth must be
  byte-identical. `inputLimit` is capped at `MAX_INPUTS_PER_ROUND` (65,536 leaves) because an L2
  insert recomputes up to 16 hashes per transaction.
- **A root is accepted once, while the E3 is in `KeyPublished`, and never zero.** `verify` rejects a
  compute proof whose `inputRoot` is not the delivered root.
- **Message layouts are a protocol.** `CRISPRemoteMessages` fixes them as 32-byte ABI words with the
  message kind first. The L2 contract and every off-chain encoder copy them by hand; a change is a
  cross-component change. The Aztec byte vectors live in
  `extensions/aztec/l1/tests/fixtures/message-vectors.json`.
- **`minVotingDuration` of zero turns off the timing checks.** It exists for local networks whose
  rounds last minutes; production deployments set one hour or more.
- **`remoteFinalityWindow` guards the compute deadline.** Interfold's compute deadline counts from
  the end of the input window, but the remote root only becomes deliverable after the L2 closes the
  round and settles. `validate` reverts `ComputeWindowTooShort` if Interfold's compute window is
  shorter than this adapter-chosen tail (zero disables it).
