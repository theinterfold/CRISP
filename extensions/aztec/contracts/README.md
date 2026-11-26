# CRISP on Aztec: contracts

`CrispAztec` (crate `crisp_aztec`, aztec-nr v6.0.0) is the Aztec side of a CRISP round whose ballots are
cast on Aztec. It is paired with `CRISPAztecProgram` on L1 (`../l1`). The workspace holds a second contract, `CrispAztecVotes`
(crate `crisp_aztec_votes`, [below](#crispaztecvotes-token-weighted-voting)), for token-weighted rounds; both use the library crate
`crisp_aztec_lib`.

```
L1 program ──ROUND──▶ open_round        voters:  register ──▶ census tree (LeanIMT, Poseidon)
L1 program ──KEY────▶ publish_key                 cast ──────▶ input tree  (LazyIMT, Poseidon)
close_round ──ROOT──▶ L1 program         (input root and count, through the Outbox)
```

Voters register a slot (an Ethereum address) with a ZKPassport proof, then cast ballots with the two base proofs of
the ballot (`user_data_encryption` and the CRISP ballot circuit, no aggregation) plus an
attestation from the availability service. The contract checks the proofs, builds both Merkle trees with the same hashing as
the Solidity code and the circuits, and sends the final input root to L1.

## Build and test

```bash
export PATH=$HOME/.aztec/versions/6.0.0/bin:$HOME/.aztec/bin:$PATH   # aztec CLI 6.0.0
cd extensions/aztec/contracts

aztec compile        # target/crisp_aztec-CrispAztec.json and target/crisp_aztec_votes-CrispAztecVotes.json, transpiled for the AVM
aztec test           # crisp_aztec_test (TXE): both contracts; add --package crisp_aztec_test
aztec-nargo test --package crisp_aztec   # pure-function unit tests of the shared code (crisp_aztec/src/tests.nr)
aztec profile gates target
pnpm -C ../sdk codegen   # regenerate the TypeScript bindings (../sdk/src/bindings/)
```

Run `aztec compile` from this directory (the workspace root); from a member directory it skips the transpile step. The `bug:
Brillig function call isn't properly covered…` lines come from aztec-nr and the vendored ZKPassport verifier.

## Vendored ZKPassport

`vendor/zkpassport/{core,registry_contract,verifier}` are copied from
[`zkpassport/zkpassport-packages`](https://github.com/zkpassport/zkpassport-packages) `packages/aztec/noir` at commit
`bc1c080fb56e3c2679f8b396056a0679637a3308` (Apache-2.0), because Nargo can only pin a git dependency to a tag and upstream has none.
Upstream's own tests are removed; `core/src/fixtures*` stays because `crisp_aztec_test` uses `fixtures::proof`. The registry is a
workspace member so that TXE can deploy it. Two CRISP patches, to drop when upstream catches up:

- **`Query::nationality_committed(exclusion, commitment)`** (`verifier/src/query.nr`). Upstream's `nationality_in` / `nationality_out`
  take the country list; a round stores only its commitment (`nationality_commitment`), so this builds the same `ParamCommitment`
  from a commitment given as is. The SDK computes it with `@zkpassport/utils` `getCountryParameterCommitment`.
- **ZKPassport circuits release 0.23.0 only** (`core/src/{constants,parse,verify}.nr`, `verifier/src/verify.nr`). Upstream is on the
  0.22.0 layout. Release 0.23.0 adds the `verification_method` public input last in every `outer_count_K` proof (`K + 6` public
  inputs instead of `K + 5`), so the proof capsule is `vk(115) ‖ proof(458) ‖ public_inputs(K + 6)`; `verify_outer_proof_core` asserts
  it equals 100 (an eMRTD chip read, the only method CRISP accepts). 0.22.0 proofs are rejected, and not supported together.
  `core/src/fixtures/proof.nr` is a real `outer_count_5` proof of release 0.23.0 (made by `e2e/zkpassport/src/prove-mock.cts`); the SDK
  builds the same capsule (`sdk/src/zkpassport.ts`).

## Storage and trees

All maps are keyed by `round_id` first, so rounds never share state. `Interfold.request` numbers E3s from `uint160(interfold) << 96`,
which does not fit a field, so the contract names a round by `round_id = uint96(e3Id)` (one L1 program serves one Interfold, so this
is injective); `Config.interfold` plus `full_e3_id` rebuild the full id wherever it is hashed or signed. Messages and logs carry the
round id. `Config` (constructor) holds the L1 program and Interfold, both EIP-712 domain separators, the availability signer's
secp256k1 key, the two base circuits' verification-key hashes and the ZKPassport settings; `RoundConfig` (`open_round`) the round's
window, limit, credits, scope hash and age and nationality rules.

Both trees take at most `MAX_LEAVES = 65536` leaves (depth 16), matching the cap L1 puts on `inputLimit`, hashed with circom
Poseidon `hash_2`. The **input tree** is zk-kit `InternalLazyIMT` with `CRISPProgram`'s leaf; only the frontier is stored and the
root is folded when the round closes. The **census tree** is zk-kit `InternalLeanIMT` with leaves `hash_2([slot, credits])`; every
root after an insert is kept, so a ballot proved against an earlier census still counts.

## Functions

| Function                | Kind                    | What it does                                                                                                                                 |
| ----------------------- | ----------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `open_round`            | public                  | Rebuilds the ROUND message content from its arguments, consumes it (secret `0`, sender = L1 program), stores `RoundConfig`. Rejects `input_limit` 0 or > 65536, an empty window. |
| `publish_key`           | public                  | Same for the KEY message; stores the committee public key.                                                                                   |
| `register`, `register_with_age`, `register_with_nationality`, `register_with_age_and_nationality` | private | Verify a ZKPassport proof bound to the caller and the round scope, spend the uniqueness nullifier, enqueue `_add_member`. One entry point per rule combination because a ZKPassport query's size is a compile-time constant. |
| `_add_member`           | public, `#[only_self]`  | Registration window, slot uniqueness, census capacity, LeanIMT insert, new root, log.                                                        |
| `cast`                  | private                 | Verifies the two base proofs, their verification-key hashes, the links between them and the availability attestation (ECDSA); enqueues `_append_input`. |
| `_append_input`         | public, `#[only_self]`  | Window, attestation expiry, known census root, input limit, parent rule, replay (`inputId`), LazyIMT insert.                                |
| `close_round`           | public                  | After `input_end`, once: folds the root, sends `(roundId, inputRoot, numInputs)` to L1.                                                      |
| views                   | utility                 | `get_config`, `get_round`, `get_committee_key`, `is_closed`, `get_input_count`, `get_census_*`, `is_slot_registered`, `get_input`. |

Message contents are `sha256_to_field(abi.encode(...))` (first 31 bytes), kind first, then `roundId`; the vectors are in
`../l1/tests/fixtures/message-vectors.json`.

Non-obvious points:

- **The public follow-ups are enqueued with `enqueue_self`**: `#[only_self]` needs `msg_sender` to be this contract, which
  `enqueue_incognito` (a hidden sender) cannot give. The public side never sees the voter's account.
- **Registration is bound twice**: to `msg_sender` (`bind_user_address`) and to the service scope `round.scope_hash`, which L1
  derives from `crisp-aztec:<chainId>:<lowercase program address>:<full e3Id, decimal>`. One document registers once per
  contract (the uniqueness nullifier); `_add_member` also refuses a slot twice.
- **The attestation covers the ballot**: `cast` recomputes `inputId` and the EIP-712 `InputAvailability` digest from its arguments.
- **Parent rule**: parent index plus one is `0` for a first ballot; otherwise the parent input must belong to the same slot and
  carry `prev_commitment`.
- **Nationality.** `nationality_mode` 0 is no rule, 1 in the list, 2 not in it. The list itself is not on Aztec: ROUND carries
  `nationality_commitment` (`nationalityCommitment` in the SDK; exclusion lists are sorted first) and the nationality
  `register*` functions require the proof's subproof to carry exactly that commitment. `open_round` and L1 both refuse an
  unknown mode, a commitment with no rule and a rule with no commitment.

## The ballot proofs

On L1 a voter's proof is a stack of three: the two base circuits (`user_data_encryption` and the CRISP ballot circuit), then
`crisp_fold` (2^21 gates). On Aztec the voter proves only the two base circuits and `cast` verifies both
(`verify_honk_proof_non_zk`), making in Noir every check the fold circuit makes (`crisp_aztec_lib/src/ballot.nr`): each
verification key's Poseidon2 hash equals `Config.{encryption,crisp}_vk_hash`; the `user_data_encryption` proof's public inputs are
exactly `[pk_commitment, ct_commitment, k1_commitment]`; its ciphertext and `k1` commitments are placed in the crisp proof's public
inputs; its public-key commitment equals the round's committee key. That both ciphertext halves share one `u` is constrained inside
`user_data_encryption` itself. The circuits are unchanged and L1 still uses the fold.

- **The proofs must never leave the device.** They are `noir-recursive-no-zk` (410 fields): zero knowledge is not needed because
  they are private arguments of `cast`, hidden inside the zero-knowledge transaction proof. A verifier that publishes them needs
  the ZK flavour or the fold.
- **One preset per deployment.** The two key hashes are fixed by the BFV preset (`insecure-64`, `secure-8192`);
  `pnpm base-vk-hashes <preset>` in `../sdk` prints them.

## Public logs

Raw public logs (`emit_public_log_unsafe`), read with `getPublicLogsByTag`; tag `1` `INPUT_COMMITTED`, `2` `MEMBER_REGISTERED`, `3`
`ROUND_CLOSED`, `4` `ROUND_OPENED`, `5` `KEY_PUBLISHED`; `CrispAztecVotes` adds `6` `STAGING_KEY_BOUND` `[round_id, index, slot, commitment, root]`. The field layouts are in `crisp_aztec/src/main.nr`; `CrispAztecVotes` emits the same tags and layouts, so one log reader serves both.

## Tests

`crisp_aztec/src/tests.nr` (testing `crisp_aztec_lib`) asserts, against values produced by the real Solidity code and viem, the tree roots, the input-tree
fixtures of `packages/crisp-contracts/tests/fixtures/input-tree*.json`, the EIP-712 digests, `inputId`, an attestation and the L1
message contents of `message-vectors.json`.

`crisp_aztec_test` (TXE) covers everything around the proofs. **TXE does not run proof verification** (`verify_honk_proof` and the
ZKPassport outer-proof check are no-ops), so real verification, the L1 round trip and the public logs need a local network (the
`../e2e` harness). The ZKPassport fixture is bound to an address TXE has no account for, so the tests re-bind it to a created account
and move its unique identifier to stand for different documents; that works only because TXE does not check the proof. The `cast`
tests use zero proofs with the real verification keys of `crisp_aztec_test/src/base_fixture.nr` (`insecure-64`).

## CrispAztecVotes: token-weighted voting

For token-weighted governance rounds (`CRISPAztecVotesProgram` on L1, `../l1`) there is no identity registration: the L1 program
reads `getPastVotes` at the round snapshot and bridges each slot's weight in an ENROLL message, so nobody can forge a weight. The
constructor has no ZKPassport settings, `open_round` consumes the 6-word ROUND
`sha256_to_field(abi.encode(1, roundId, numOptions, inputStart, inputEnd, inputLimit))`, and `publish_key`, `cast`, `_append_input`,
`close_round`, the trees and the logs are as in `CrispAztec`. The weight is the census leaf's second input, so a ballot's `credits` is
the slot's weight.

| Function | Kind | What it does |
| -------- | ---- | ------------ |
| `enroll(round_id, slot, weight, leaf_index)` | public, permissionless | Consumes ENROLL `abi.encode(4, roundId, uint256(slot), weight)`; the round must be open, `now < input_end`, the slot not enrolled, `weight != 0`. Inserts the leaf `hash_2([slot, weight])` into the census LeanIMT, keeps the new root and logs `MEMBER_REGISTERED`. |
| `bind_staging_key(round_id, slot, public_key_x, public_key_y, signature)` | private | The slot's wallet signs EIP-712 `StagingKey(uint256 e3Id)` in the ballot domain. Checks the secp256k1 signature in-circuit and `address(pubkey) == slot`, derives `secret = Poseidon2::hash([r_hi, r_lo, s_hi, s_lo], 4)` (the signature's `r`, `s` as 128-bit big-endian limbs) and the commitment `hash_2([secret, round_id])`, and enqueues `_bind`. The signature stays on the device. |
| `_bind(round_id, slot, commitment)` | public, `#[only_self]` | Slot enrolled, at most `MAX_STAGING_BINDS = 3` binds per slot and round, commitment not already in the tree; LeanIMT insert into the round's staging tree, keeps the root, logs `STAGING_KEY_BOUND`. |
| views | utility | The `CrispAztec` views with `is_slot_enrolled` for `is_slot_registered`, plus `get_staging_bind_count`, `get_staging_root`, `is_staging_root_known`. |

The staging tree lets a voter prove membership (`staging_pass_votes`) without naming a slot: a governance slot's public key is public,
so a tag derived from it would link a staging request to its sender. Only `hash_2([secret, round_id])` leaves the voter.
Storage is merged into `Counts` and `SlotState` structs because the contract's storage type would otherwise exceed Noir's type-complexity limit.

## Gas and gates

Public L2 gas is limited to 6,000,000 per transaction in the AVM. Each circom Poseidon `hash_2` costs about 270,000 L2 gas, so an
insert costs one hash per trailing one bit of its index (16 at most) and `close_round` one hash per level: at index 65535
`_add_member`, `_append_input` and `close_round` use 4.5 to 4.7M. Private gates (`aztec profile gates target`): `cast` 227,954,
`register` 22,944; the ZKPassport proof itself is verified by the registry (`assert_proof_valid`, 25,175 gates). A mock-document
`outer_count_6` proof takes 43 to 71 seconds to generate.
