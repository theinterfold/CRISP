# CRISP on Aztec: contracts

`CrispAztec` (crate `crisp_aztec`, aztec-nr v6.0.0) is the Aztec side of a CRISP round whose ballots are
cast on Aztec. It is paired with `CRISPAztecProgram` on L1 (`../l1`):

```
L1 program ──ROUND──▶ open_round        voters:  register ──▶ census tree (LeanIMT, Poseidon)
L1 program ──KEY────▶ publish_key                 cast ──────▶ input tree  (LazyIMT, Poseidon)
close_round ──ROOT──▶ L1 program         (input root and count, through the Outbox)
```

Voters register a slot (an Ethereum address) with a ZKPassport proof, then cast ballots with a fold proof
(`noir-recursive` proof of the CRISP fold circuit) plus an attestation from the availability service. The
contract is the on-chain ledger: it checks the proofs, builds both Merkle trees with the same hashing as
the Solidity code and the circuits, and sends the final input root to L1.

## Build and test

```bash
export PATH=$HOME/.aztec/versions/6.0.0/bin:$HOME/.aztec/bin:$PATH   # aztec CLI 6.0.0
cd extensions/aztec/contracts

aztec compile        # target/crisp_aztec-CrispAztec.json, transpiled for the AVM
aztec test           # TXE tests of crisp_aztec_test + the vendored ZKPassport registry's own tests
aztec profile gates target
pnpm -C ../sdk codegen   # regenerate the TypeScript bindings (../sdk/src/bindings/CrispAztec.ts)
```

Run `aztec compile` from this directory (the workspace root); from a member directory it skips the
transpile step. The `bug: Brillig function call isn't properly covered…` lines it prints come from
aztec-nr and the vendored ZKPassport verifier, not from this contract.

`aztec test` runs three suites:

- `crisp_aztec/src/tests.nr` (`aztec-nargo test --package crisp_aztec`): pure functions against the
  Solidity code they replace, see [Agreement with Solidity](#agreement-with-solidity).
- `crisp_aztec_test` (TXE): the contract end to end, see [What the TXE tests cover](#what-the-txe-tests-cover).
- The vendored ZKPassport registry's tests.

## Layout

| Path                                  | Contents                                                              |
| ------------------------------------- | --------------------------------------------------------------------- |
| `crisp_aztec/src/main.nr`             | The contract                                                          |
| `crisp_aztec/src/tree.nr`             | LazyIMT and LeanIMT insert/root over a `NodeStore`                    |
| `crisp_aztec/src/nodes.nr`            | `NodeStore` over public storage                                       |
| `crisp_aztec/src/hashing.nr`          | EIP-712 digests, `inputId`, input leaf, L1 message contents           |
| `crisp_aztec/src/identity.nr`         | ZKPassport service configuration                                      |
| `crisp_aztec/src/constants.nr`        | Tree sizes, empty-subtree roots, typehashes, tags                     |
| `crisp_aztec/src/tests.nr`            | Unit tests (agreement with Solidity)                                  |
| `crisp_aztec_test/`                   | TXE tests and their signed fixtures                                   |
| `vendor/zkpassport/`                  | ZKPassport Aztec verifier, core and registry, vendored                |

### Vendored ZKPassport

`vendor/zkpassport/{core,registry_contract,verifier}` are copied unchanged from
[`zkpassport/zkpassport-packages`](https://github.com/zkpassport/zkpassport-packages)
`packages/aztec/noir` at commit `bc1c080fb56e3c2679f8b396056a0679637a3308` (Apache-2.0). They are
vendored because Nargo can only pin a git dependency to a tag and the upstream repository has no tag for
these packages. The only things they pull from the network are `aztec-nr` v6.0.0 and the tag
`noir-v1.0.0` of `zkpassport/circuits`. The registry is a workspace member so that TXE can deploy it.
Replace the directory with a tagged dependency once upstream publishes one.

## Storage

All maps are keyed by `round_id` first, so rounds never share state.

**Round id.** `Interfold.request` numbers E3s from `uint160(interfold) << 96`, so a real `e3Id` is a 256-bit
value that does not fit a field. The contract names a round by `round_id = uint96(e3Id)` (a `Field` below
2^96, asserted in `open_round`); one L1 program serves one Interfold, so this is injective. The constructor
stores the Interfold address (`Config.interfold`) and `full_e3_id` rebuilds `interfold(20 bytes) ‖ round_id(12
bytes)` wherever the full id is hashed or signed: the EIP-712 `Ballot` and `InputAvailability` digests and
`inputId`. Those equal the L1, server and `@crisp-e3/sdk` values. Messages and logs carry the round id.

| Slot                            | Type                                 | Written by                     |
| ------------------------------- | ------------------------------------ | ------------------------------ |
| `config`                        | `PublicImmutable<Config>`            | constructor                    |
| `rounds[round]`                    | `PublicImmutable<RoundConfig>`       | `open_round`                   |
| `committee_keys[round]`            | `PublicImmutable<Field>`             | `publish_key`                  |
| `closed[round]`                    | `PublicMutable<bool>`                | `close_round`                  |
| `census_count[round]`              | `PublicMutable<u32>`                 | `_add_member`                  |
| `census_nodes[round][level]`       | `PublicMutable<Field>`               | `_add_member`                  |
| `census_roots[round][root]`        | `PublicMutable<bool>`                | `_add_member`                  |
| `registered_slots[round][slot]`    | `PublicMutable<bool>`                | `_add_member`                  |
| `input_count[round]`               | `PublicMutable<u32>`                 | `_append_input`                |
| `input_frontier[round][level]`     | `PublicMutable<Field>`               | `_append_input`                |
| `inputs[round][index]`             | `PublicMutable<InputEntry>`          | `_append_input`                |
| `input_ids[round][key]`            | `PublicMutable<bool>`                | `_append_input`                |

- `Config`: L1 program and Interfold (`EthAddress`), ballot and availability EIP-712 domain separators, the
  availability signer's secp256k1 key (x, y), the fold verification-key hash, the ZKPassport domain hash,
  circuits version, validity period and registry address. Bytes32 values are stored as two 128-bit halves.
- `RoundConfig`: `num_options`, `credits`, `input_start`, `input_end`, `input_limit`, `scope_hash`,
  `min_age`, `allow_mock_documents`.
- `InputEntry`: `(slot, ct_commitment)`, what a revote must name as its parent.
- `input_ids` keys are `keccak256(abi.encode("CRISP_INPUT_V1", program, e3Id (full), encryptedVoteHash,
  ciphertextCommitment, slot, parentIndexPlusOne))` truncated to 31 bytes, the same `inputId` L1 computes.

## Trees

Both trees take at most `MAX_LEAVES = 65536` leaves (depth 16), matching the cap L1 puts on `inputLimit`.
Hashing is circom Poseidon `hash_2`.

- **Input tree**: zk-kit `InternalLazyIMT` (dynamic depth, zero-padded, `n = 0` is the empty depth-1
  root `Z_1`). Leaves are `sha256(encryptedVoteHash ‖ ciphertextCommitment ‖ slot(20 bytes) ‖ parentIndexPlusOne(5 bytes))`
  reduced mod p, exactly `CRISPProgram`'s leaf. Only the frontier is stored (one node per level); the root
  is folded from it when the round closes.
- **Census tree**: zk-kit `InternalLeanIMT`, leaves `hash_2([slot, credits])`. Every root after an insert
  is kept in `census_roots`, so a ballot proved against an earlier census still counts.

`tree.nr` does not read the stored nodes except through the `NodeStore` trait, so the algorithms are
tested against Solidity-produced roots with an in-memory store.

## Functions

| Function                | Kind                    | Caller     | What it does                                                                                                                                                  |
| ----------------------- | ----------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `constructor`           | public initializer      | deployer   | Stores `Config` (11 arguments: `l1_program`, `interfold`, the two domain separators, the signer key halves, `fold_vk_hash`, the ZKPassport settings and registry).                                                                                                          |
| `open_round`            | public                  | anyone     | Rebuilds the ROUND message content from its arguments, consumes it (secret `0`, sender = L1 program), stores `RoundConfig`. Rejects `input_limit` 0 or > 65536, and an empty window. |
| `publish_key`           | public                  | anyone     | Same for the KEY message; stores the committee public key.                                                                                                    |
| `register`              | private                 | voter      | Rounds with `min_age == 0`. Verifies a ZKPassport proof bound to the caller's address, spends the uniqueness nullifier, enqueues `_add_member`.              |
| `register_with_age`     | private                 | voter      | Rounds with `min_age != 0`: also proves `age >= min_age`. A separate entry point because a ZKPassport query's size is a compile-time constant.             |
| `_add_member`           | public, `#[only_self]`  | contract   | Registration window, slot uniqueness, census capacity, LeanIMT insert, records the new root.                                                                 |
| `cast`                  | private                 | voter      | Verifies the fold proof (9 public inputs), the verification-key hash and the availability attestation (ECDSA); enqueues `_append_input`.                    |
| `_append_input`         | public, `#[only_self]`  | contract   | Window, attestation expiry, known census root, input limit, parent rule, replay (`inputId`), LazyIMT insert.                                                 |
| `close_round`           | public                  | anyone     | After `input_end`, once: folds the root, sends `(roundId, inputRoot, numInputs)` to L1, returns the root.                                                      |
| views                   | utility                 | anyone     | `get_config`, `get_round`, `get_committee_key`, `is_closed`, `get_input_count`, `get_census_count`, `get_census_root`, `is_census_root_known`, `is_slot_registered`, `get_input`. |

Notes that are not obvious:

- **The public follow-ups are enqueued with `enqueue_self`.** `#[only_self]` needs `msg_sender` to be this
  contract, which `enqueue_incognito` (a hidden sender) cannot give. The public side sees only
  `CrispAztec`, never the voter's account.
- **Registration is bound twice.** The ZKPassport proof is bound to `msg_sender` (`bind_user_address`) and
  to the service scope `round.scope_hash`, the hash L1 derives from
  `crisp-aztec:<chainId>:<lowercase program address>:<full e3Id, decimal>`. The uniqueness nullifier is emitted for the
  proof's unique identifier, so one document registers once per contract; `_add_member` additionally
  refuses a slot twice.
- **The attestation covers the ballot.** `cast` recomputes `inputId` and the EIP-712 `InputAvailability`
  digest from its arguments, so the signature fixes the ciphertext commitment, the encrypted-vote hash,
  the slot and the parent. `expires_at` is checked in public with `now < expires_at`, as L1 does.
- **The fold proof's public inputs**, in circuit order: previous commitment, the two 128-bit halves of the
  EIP-712 ballot digest, slot, census root, `is_first_vote`, number of options, ciphertext commitment,
  committee key. The contract
  checks `poseidon2(vk) == config.fold_vk_hash` (`getFoldRecursiveVerificationKey` in the SDK computes the
  same hash) and calls `verify_honk_proof` with it.
- **Parent rule**: parent index plus one is `0` for a first ballot, which must name no previous
  commitment; otherwise the parent input must belong to the same slot and carry `prev_commitment`.
- **No chain id in the constructor**: both domain separators already commit to it.
- Message contents are `sha256_to_field(abi.encode(...))` (first 31 bytes of the digest): ROUND
  `(1, roundId, numOptions, credits, inputStart, inputEnd, inputLimit, scopeHash, minAge, allowMock)`, KEY
  `(2, roundId, committeePublicKeyField)`, ROOT `(3, roundId, inputRoot, numInputs)`. The vectors are in
  `../l1/tests/fixtures/message-vectors.json`.

## Public logs

Raw public logs (`emit_public_log_unsafe`): the first field of each log is its tag, then the fields in
order. A server reads them with `getPublicLogsByTag`. Fields are full field elements; `vote_hash_hi` and
`vote_hash_lo` are the first and last 16 bytes of `encryptedVoteHash`.

| Tag | Event              | Fields after the tag                                                                    |
| --- | ------------------ | --------------------------------------------------------------------------------------- |
| 1   | `INPUT_COMMITTED`  | `round_id, index, slot, ct_commitment, vote_hash_hi, vote_hash_lo, parent_index_plus_one`  |
| 2   | `MEMBER_REGISTERED`| `round_id, index, slot, census_leaf, census_root`                                          |
| 3   | `ROUND_CLOSED`     | `round_id, input_root, num_inputs`                                                         |
| 4   | `ROUND_OPENED`     | `round_id`                                                                              |
| 5   | `KEY_PUBLISHED`    | `round_id, committee_public_key`                                                           |

## Agreement with Solidity

`crisp_aztec/src/tests.nr` asserts, against values produced by the real Solidity code and viem:

- LazyIMT roots (`n` = 0…70) and LeanIMT roots (`n` = 1…70) of zk-kit `InternalLazyIMT` /
  `InternalLeanIMT` over the same leaves; the 16-level full tree at capacity.
- The input-tree roots and leaf hashes of the three fixtures in
  `packages/crisp-contracts/tests/fixtures` (`input-tree*.json`, built by `CRISPProgram`).
- EIP-712 ballot and availability digests, `inputId` (ABI encoding with the string tail), the typehash
  constants, and a secp256k1 attestation signed with viem.
- The three L1 message contents of `message-vectors.json`.

## What the TXE tests cover

TXE does **not** run proof verification: `verify_honk_proof` and the ZKPassport outer-proof check are
no-ops in the simulator. The tests therefore cover everything around the proofs and leave the proofs
to the local-network run:

- ROUND and KEY consumption, replay and tampered arguments, limit and window validation.
- Registration: capsule delivery, registry lookups (a vendored registry deployed and seeded at the local
  network's canonical address, using ZKPassport's own age fixture), bound-address and scope mismatches, one
  registration per document and per slot, the registration window, the age and no-age entry points.
- The census root after 1, 2 and 3 registrations equals the SDK's `LeanIMT` (poseidon2) root.
- Casting: attestation signature (right signer, wrong signer, tampered ballot, expired), verification-key
  hash, unknown census root, parent rule, replay, limit, window, missing committee key.
- Three casts that reproduce `input-tree-append.json` and a `close_round` whose returned root equals the
  Solidity-produced `inputRoot`.
- `close_round`: not before the window ends, once, empty tree root.

The ZKPassport fixture is bound to a fixed address that TXE has no account for, so the tests re-bind it
to a created account and move its unique identifier to stand for different documents. That only works
because TXE does not check the proof. The fold proof in `crisp_aztec_test/src/fold_fixture.nr` is a real
proof (natively verified with `bb verify -t noir-recursive`) and its verification-key hash is the one the
SDK computes. Real verification of both proofs, the L1 round trip and the public logs need a local
network; `../sdk` and `../../../` e2e drive that.

## Gas and gates

Measured on the local network (aztec 6.0.0) by simulating the public functions at the worst-case tree
position. Public L2 gas is limited to 6,000,000 per transaction in the AVM.

| Public follow-up (worst case)              | Position                      | Public L2 gas | Whole simulated tx |
| ------------------------------------------ | ----------------------------- | ------------- | ------------------ |
| `_add_member` (`register`)                 | first member                  | 166,706       | 757,506            |
| `_add_member` (`register`)                 | index 32767 (15 hashes)       | 4,235,471     | 4,826,271          |
| `_add_member` (`register`)                 | index 65535 (16 hashes)       | 4,506,722     | 5,097,522          |
| `_append_input` (`cast`)                   | first input                   | 204,520       | 795,320            |
| `_append_input` (`cast`)                   | index 32767 (15 hashes)       | 4,267,030     | 4,857,830          |
| `_append_input` (`cast`)                   | index 65535 (16 hashes)       | 4,537,864     | 5,128,664          |
| `close_round`                              | 32767 inputs                  | 4,424,520     | 5,015,320          |
| `close_round`                              | 65535 inputs                  | 4,695,771     | 5,286,571          |

Each circom Poseidon `hash_2` costs about 270,000 L2 gas, so a tree insert costs one hash per trailing one
bit of its index (16 at most) and `close_round` one hash per level. The worst case leaves about 1.3M of the
6M budget. DA gas is 512 to 640 per insert and 288 for `close_round`. "Whole simulated tx" is the public
function called alone, so it includes the transaction overhead (about 590,000) that a real `register` or
`cast` pays once, with its private phase on top.

The numbers come from a scratch copy of the contract with `#[only_self]` removed from the two helpers and a
function that sets the counts directly (a 65,535-leaf tree cannot be filled one insert at a time). The tree
code and storage layout are the production ones. Hash cost does not depend on the node values, so an empty
frontier measures the same. `open_round` and `publish_key` were executed on the network but not metered.

Private gate counts (`aztec profile gates target`):

| Function            | Gates   |
| ------------------- | ------- |
| `cast`              | 203,091 |
| `register`          | 22,944  |
| `register_with_age` | 23,025  |

The ZKPassport proof itself is verified by the registry (`assert_proof_valid`, 25,175 gates) and the
fold proof by `verify_honk_proof` inside `cast`.
