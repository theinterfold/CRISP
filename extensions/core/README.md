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
| `_sendToRemote(e3Id, message) returns (content, index)`      | Deliver one of the `CRISPRemoteMessages` layouts to the remote CRISP contract; `index` is the message's position in the bridge's queue. Called inside `validate` (ROUND), `publishCommitteeKey` (KEY) and `registerMember` (MEMBER). |
| `scopeOf(e3Id)`                                              | The string a voter's identity proof is bound to. Unique per program, chain and round.                                                            |
| an entry point calling `_acceptInputRoot(e3Id, root, count)` | Authenticate the ROOT message through the L2's own bridge first. Everything the base needs is the root and the count.                            |

`CRISPAztecProgram` (`extensions/aztec/l1`) is the reference implementation. A new L2 adds a sibling
under `extensions/<l2>/`, imports `@crisp-e3/extension-core/contracts/CRISPRemoteProgram.sol`, and
implements the three hooks.

## Registering voters: on the L2 or on L1

A round's custom parameters are
`abi.encode(uint256 numOptions, uint256 credits, uint256 minAge, bool allowMockDocuments, address registrar,
uint8 nationalityMode, string[] countries, uint256 nationalityCommitment)`. The poll creator picks one
registration path per round, never both (they would be two uniqueness domains):

- **`registrar == address(0)`: the L2 verifies the ZKPassport proof** (on Aztec, today only with proofs of a
  Barretenberg version the rollup supports). With a nationality rule the L2 checks ZKPassport's Poseidon2
  commitment of the country list, which L1 cannot recompute: `nationalityCommitment` must be a non-zero field
  element, and a wrong one only makes the poll unregistrable. Apps recompute it from `RoundRules` and refuse a
  mismatch.
- **`registrar != address(0)`: voters register on L1.** `registrar` must be a contract, and only it may call
  `registerMember(e3Id, slotAddress)`, which sends MEMBER (`(4, roundId, slot)`) to the L2 and emits `MemberSent`.
  `ZKPassportRegistrar` (this package) is the registrar: it verifies a ZKPassport proof with ZKPassport's root
  verifier on L1, checks the age and nationality rules, and keeps one registration per document per round. Voting
  stays on the L2. The proof binds the voter's per-round slot key (not an Ethereum account), so anyone, for example the
  CRISP server, may submit it. `nationalityCommitment` is 0 here: the registrar checks the list with ZKPassport's own
  helper.

`nationalityMode` is 0 (none; `countries` empty), 1 (nationality in `countries`) or 2 (not in `countries`). Entries
are ICAO alpha-3 codes of exactly three letters `A-Z` (`"DEU"`), 1 to 200 of them. `validate` stores the rules
(`getRules(e3Id)`) and emits `RoundRules(e3Id, registrar, minAge, allowMockDocuments, nationalityMode, countries,
nationalityCommitment)`, the one place a client reads the list a round was created with. The ROUND message carries
`l1Registration = registrar != 0`, the mode and the commitment so the L2 enforces the same path.

`ZKPassportRegistrar` is chain-agnostic and takes its root verifier (ZKPassport's, the same address on every network
it supports), the program, the ZKPassport domain and the proof validity window at construction. It replaces the
service configuration of every proof with the round's (`domain`, `program.scopeOf(e3Id)`, validity, the round's
mock-document setting), so a proof made for another service or round does not verify. Its tests run against a mock
root verifier, which proves only this package's logic, not that ZKPassport accepts a proof.

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
  message kind first (ROUND has 13 words: the round configuration, then `l1Registration`, `nationalityMode`,
  `nationalityCommitment`; MEMBER is `(4, roundId, slot)`). The L2 contract and every off-chain encoder copy them by hand; a change is a
  cross-component change. The Aztec byte vectors live in
  `extensions/aztec/l1/tests/fixtures/message-vectors.json`.
- **`minVotingDuration` of zero turns off the timing checks.** It exists for local networks whose
  rounds last minutes; production deployments set one hour or more.
- **`remoteFinalityWindow` guards the compute deadline.** Interfold's compute deadline counts from
  the end of the input window, but the remote root only becomes deliverable after the L2 closes the
  round and settles. `validate` reverts `ComputeWindowTooShort` if Interfold's compute window is
  shorter than this adapter-chosen tail (zero disables it).

## Staging pass (`circuits/staging_pass`)

The CRISP server of a remote round stages a ciphertext and signs the availability attestation
**before** the `cast`, because the L2 contract requires it. Left open, anyone could fill the staging
storage with bytes that are never cast. Requiring the slot's signature would let the server tell a vote
from a mask, which the ballot design keeps indistinguishable. The pass is a Noir circuit, chain-agnostic
(it needs only the census tree and an ECDSA key), that proves "I hold the key of SOME slot registered in
this round's census" plus a one-time rate-limit tag, and reveals neither the slot nor the key:

- private: the slot public key, an ECDSA secp256k1 signature of the request digest, the census Merkle
  path (the leaf `Poseidon2(slot, credits)` and the LeanIMT path are `crisp_lib`'s, so the root is the
  census root exactly), the credits and the counter `k`;
- public: `census_root`, `round_id`, `request_digest` (two 128-bit halves), `max_requests`, `tag`;
- `k < max_requests`, `tag = Poseidon(x_hi, x_lo, y_hi, y_lo, round_id, k)`.

The tag hashes the slot **public key**, never the address. The address is public (the registration and
the census carry it), so a tag over it would be linked to its slot by anyone. The public key is not
published (a ballot's signature is a private input of its proof; the registration binds only the
address), so tags are unlinkable to slots **as long as the key stays unpublished**: a slot owner who
shows a signature made with the key can be linked to its tags. `request_digest` binds the pass to one
staging request (`CRISP_STAGING_V1`, chain, program, e3Id, ciphertext commitment, target slot, parent
index), so it cannot be replayed for other bytes. A mask is staged with the pass of the masker's own slot
while the request names the masked slot, so a vote and a mask look alike; an unregistered voter cannot
stage. The server side is in `extensions/aztec/README.md` ("Staging pass"), the prover in
`extensions/aztec/sdk` (`buildStagingPass`).

`circuits/staging_pass/build.sh` compiles it (`nargo` 1.0.0-rc.3, as `circuits/`) and writes
`compiled/staging_pass.json` (the SDK loads it) and `compiled/staging_pass.vk` (the server loads it,
and the Docker image ships it) for bb 6.0.0's default `evm` target (keccak transcript, zero knowledge).
Both are checked in: rerun the script whenever `circuits/lib` or the circuit changes, or the server
rejects every pass. `nargo test` in the circuit directory runs its tests (valid pass, wrong key, non-member,
`k >= max_requests`, digest binding, tag determinism). 80k gates (circuit size 81,666, 2^17 dyadic); a pass
takes about 6 s to prove in Node with the WASM backend.
