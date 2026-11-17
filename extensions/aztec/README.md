# CRISP on Aztec

Voters register with ZKPassport and cast CRISP ballots on Aztec v6; Interfold, the committee and the
compute stay on Ethereum. The poll creator makes one L1 transaction (`Interfold.request`); voter
transactions are paid by Aztec's SponsoredFPC; every relay step is permissionless (`keeper/`).
See `../README.md` for the cross-chain flow.

| Path | Contents |
| --- | --- |
| `l1/` | `CRISPAztecProgram`: Inbox (ROUND, KEY, MEMBER) and Outbox (ROOT) adapter over `CRISPRemoteProgram`; the per-poll `ZKPassportRegistrar` is `../core/contracts`. |
| `contracts/` | aztec-nr `CrispAztec`: ZKPassport registration (age, nationality) or L1-registered members, census LeanIMT, ballot verification, input LazyIMT, close. Vendored ZKPassport Aztec verifier/registry. |
| `sdk/` | `@crisp-e3/aztec`: voter client, deploy, L1 helpers, registrar calldata and relay, round rules and nationality commitments, log readers, generated bindings. |
| `keeper/` | Relay service: open round, relay and publish key, add L1-registered members, close round, submit root. |
| `ingest/` | Rust crate the CRISP server uses to read `INPUT_COMMITTED` logs. |
| `e2e/` | Full-round harness on the Aztec local network (`pnpm test:e2e:aztec`: one round per registration path) and mock-document ZKPassport proof tooling. |

## Registration paths and nationality

The creator picks, per poll, how voters register, in the custom parameters of `Interfold.request`:

```
abi.encode(uint256 numOptions, uint256 credits, uint256 minAge, bool allowMockDocuments,
           address registrar, uint8 nationalityMode, string[] countries, uint256 nationalityCommitment)
```

`@crisp-e3/aztec` encodes and decodes it (`encodeCustomParams` / `decodeCustomParams`, with `RoundRules`).
`minAge` is 0 (no rule) to 99. `nationalityMode` is 0 none, 1 the voter's nationality is in `countries`,
2 it is not (ICAO alpha-3 codes such as `DEU`, at most 200). Voters never need an Ethereum wallet: only
the creator connects one.

| | Aztec path (`registrar == 0x0`) | L1 path (`registrar` = the program's `ZKPassportRegistrar`) |
| --- | --- | --- |
| Proof verified by | `CrispAztec.register*` in private (ZKPassport `compressed` proof, 4 to 6 subproofs) | `ZKPassportRegistrar.register` on L1 (ZKPassport's root verifier) |
| Who submits | The voter, from an Aztec account (fees by SponsoredFPC) | The CRISP server, which relays the calldata (`POST /registration/l1`); no wallet, no gas for the voter |
| Reaches the census by | `register*` inserts the slot | MEMBER message (L1 → L2) that the keeper turns into `add_member_from_l1` |
| Nationality list | Committed in the ROUND message (`nationalityCommitment`); the circuit proves the voter's list commitment equals it | The registrar checks `countries` against the list the program stored (`RoundRules`) |

A round uses one path: `register*` refuses an L1-path round and `add_member_from_l1` an Aztec-path one.

**Aztec path.** The contract entry point follows the rules: `register` (no rule), `register_with_age`,
`register_with_nationality`, `register_with_age_and_nationality` (the SDK's `client.register` picks it).
Each takes the ZKPassport outer proof of 4 (bind only), 5 or 6 subproofs (age, nationality, bind). For a
nationality rule the contract rebuilds the expected parameter commitment from the round's stored
`nationalityCommitment` (ZKPassport's country-list commitment, with exclusion lists sorted:
`nationalityCommitment(mode, countries)` in the SDK) and the vendored ZKPassport `Query` gained
`nationality_committed(exclusion, commitment)` for that (see `contracts/README.md`, "Vendored ZKPassport").

**L1 path.** The voter proves identity in the ZKPassport app with `senderAddress = slot` and
`chainId = the L1 chain`, and a request `domain` equal to the registrar's. The app sends
`registerOnL1Calldata(...)` (SDK) to the CRISP server's `POST /registration/l1`. The registrar verifies the
proof, the binding, the age and nationality rules, and one registration per document per round, then asks
the program to send a MEMBER message (`MemberSent`). The keeper relays it to Aztec with
`add_member_from_l1` (the message content is `(roundId, slot)`, so it cannot be consumed for another slot
or round); registration closes with the input window on both layers. The registrar's `countries` argument
must equal the round's list, and `allowMockDocuments` stays under the creator's control as before.

The L1 path trusts the registrar's verdict and the program's MEMBER messages for the census; the Aztec path
trusts only the proof Aztec verifies itself.

## Design constraints

- **Round ids.** Interfold e3Ids (`uint160(interfold) << 96 | seq`) exceed the BN254 field, so Aztec
  and the L1↔L2 messages key rounds by `roundId = e3Id & (2^96 - 1)`. The Aztec contract rebuilds
  the full e3Id (`interfold ‖ roundId`) for the EIP-712 ballot and availability digests and `inputId`,
  which therefore equal the L1 CRISP ones.
- **Trees.** The input tree is byte-identical to `CRISPProgram`'s (sha256 leaf, zk-kit LazyIMT,
  circom Poseidon, dynamic depth), so the OpenVM guest and program server are unchanged. circom
  Poseidon costs ~271k L2 gas per hash in the AVM, which caps both trees at 65,536 leaves; the worst
  insert or close uses ~4.7M of the 6M public gas budget.
- **Ballot proof.** The voter proves only the three base circuits (`user_data_encryption_ct0`, `_ct1`, crisp) with the
  `noir-recursive-no-zk` target (410 fields each); the private `cast` verifies all three with
  `verify_honk_proof_non_zk` against the stored VK hashes and makes the checks the `user_data_encryption` and fold
  circuits make on L1 (`contracts/README.md`, *The ballot proofs*). That drops the two 2^21-gate aggregation proofs
  from the voter's work. The proofs are private arguments of `cast` and never leave the voter's device.
- **Identity.** A round registers its voters on one of two paths, chosen by its creator (see
  *Registration paths and nationality* below). On the Aztec path, ZKPassport `compressed` outer
  proofs (bb 6.0.0) are verified in the private `register*` functions, bound to the caller, scoped
  per round; one registration per document per round. On the L1 path the L1 `ZKPassportRegistrar`
  verifies the proof and the slot reaches Aztec as a MEMBER message. Either way a person holding two
  documents can still register twice.
- **Availability.** Ciphertexts stay off-chain: the CRISP server stages them and signs an
  `InputAvailability` attestation that `cast` verifies, as on L1. The server stages a ciphertext only
  against a **staging pass**, an anonymous proof that the sender holds the key of some registered slot
  (below), so staging is not open to anyone who wants to fill its storage.
- **Finality.** The ROOT message is consumable on L1 only after the Aztec epoch proof; deployments
  set `remoteFinalityWindow` so requests with a too-short compute window are refused.

## Server

The CRISP server runs Aztec rounds with `PROGRAM_KIND=aztec`. One instance serves one program: in
this mode `E3_PROGRAM_ADDRESS` is the `CRISPAztecProgram` and the server does not serve L1 CRISP
rounds. The chain-agnostic seam is `extensions/core/remote-input` (crate `crisp-remote-input`); the
Aztec side is `extensions/aztec/ingest` (crate `crisp-aztec-ingest`); the integration is in
`server/src/server/{indexer/remote_input.rs,data_availability/remote_input.rs}`.

### Configuration

| Variable                        | Meaning                                                                                                   |
| ------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `PROGRAM_KIND`                  | `crisp` (default) or `aztec`.                                                                             |
| `E3_PROGRAM_ADDRESS`            | The `CRISPAztecProgram` (L1). It is the `verifyingContract` of the availability attestation.              |
| `AZTEC_NODE_URL`                | Aztec node JSON-RPC. Required.                                                                            |
| `AZTEC_CONTRACT_ADDRESS`        | The `CrispAztec` contract, 32 bytes hex. Required.                                                        |
| `AZTEC_ATTESTATION_TTL_SECONDS` | Validity of an attestation, counted from the later of the Aztec and the local clock. Default 900.         |
| `AZTEC_START_BLOCK`             | First Aztec block scanned for inputs. Unset scans from the first block.                                   |
| `ZKPASSPORT_REGISTRAR_ADDRESS`  | The program's `ZKPassportRegistrar`. Optional: set, the server relays L1 registrations (`POST /registration/l1`). |
| `STAGING_PASS_VK_PATH`          | Verification key of the staging pass circuit (`extensions/core/circuits/staging_pass/compiled/staging_pass.vk`). Required. |
| `STAGING_MAX_REQUESTS_PER_SLOT` | Staging passes one slot key may use per round: its ciphertext stagings, votes and masks together. Default 16. |
| `BB_BINARY_PATH`                | The Barretenberg CLI that verifies passes, `bb` 6.0.0 exactly (checked at startup). Default `bb` on the `PATH`; the Docker image ships it. |
| `BB_CRS_PATH`                   | `bb`'s reference-string directory. Unset: `~/.bb-crs`, which `bb` fills from the internet on first use. The Docker image ships it. |
| `PRIVATE_KEY`                   | Signs the attestations. The Aztec contract must be deployed with its public key (see `config` below).    |

The server relays no inputs in this mode (it only relays L1 registrations, below). Outside local chains, `RELAY_MIN_BALANCE_ETH=0` satisfies the
relay validation.

### Round life cycle

1. **Request.** The poll creator requests the round on L1. The server decodes the program's custom
   parameters, `abi.encode(numOptions, credits, minAge, allowMockDocuments, registrar, nationalityMode,
   countries, nationalityCommitment)`, records the round, and starts it when the committee key is
   indexed. It has no census and posts no Merkle root;
   `/rounds/request` refuses in this mode.
2. **Voting.** The voter encrypts a ballot, sends the ciphertext and a staging pass to
   `POST /voting/remote-input`, and submits the returned attestation with the Noir proofs to Aztec.
   Aztec verifies the proofs and accepts the input.
3. **Ingest.** Every 5 seconds the server reads the `INPUT_COMMITTED` public logs of the contract
   (`node_getPublicLogsByTags`, tag `1`, resumed from a per-round cursor) and stores each input in
   the same round record the L1 `InputCommitted` handler fills, pairing it with the bytes it staged
   under the ciphertext hash. Only blocks of a proven epoch are read: each query takes the proven tip
   from `node_getChainTips` and sets `toBlock = proven + 1` (exclusive), because the node drops the
   unproven blocks of an epoch that is never proven and reuses their numbers, which would leave the
   cursor past the replacement logs. The root reaches L1 after the same epoch proof, so this adds no
   wait. An input whose bytes the server never staged stops ingestion of that round with a warning:
   the round cannot be computed without it.
4. **Compute.** When the L1 program emits `InputRootSubmitted(e3Id, inputRoot, numInputs)` and the
   server holds exactly `numInputs` inputs, it rebuilds the input tree from them, as the Secure
   Process does (`sha256` leaves, zk-kit lazy IMT, circom Poseidon), and computes only if the root
   equals `inputRoot`. A different root logs an error and the round is not computed; the check runs
   again every minute. There is no input deadline and no `pendingInputCount` gate. Fewer inputs than
   `numInputs` wait; more is an error. The compute, `stage_output` and `publishCiphertextOutput`
   steps are the ones of the L1 path.
5. **Release.** The staged bytes of a round are deleted, and the round is no longer polled, once its
   ciphertext output is published, or when Interfold reports its stage as `Failed` or
   `CiphertextReady`/`Complete`, or when its compute deadline has passed without an output. The stage
   is read once a minute per round.

### Endpoints

`POST /voting/remote-input` (404 unless `PROGRAM_KIND=aztec`)

The `round_id` of the request is the full Interfold E3 id (decimal), not the contract's 96-bit round
id.

```json
{
  "round_id": "101158381344220681886982062250077768856931888677917611139287511601085014867975",
  "slot": "0x…",
  "ciphertext": "0x…",
  "ciphertext_commitment": "0x…32 bytes",
  "parent_index_plus_one": 0,
  "staging_pass": { "proof": "0x…", "public_inputs": ["0x…32 bytes", "… 6 in all"] }
}
```

The server computes `keccak256(ciphertext)` itself. It refuses the request (400) when the staging
pass is refused (below), when the round is unknown, belongs to another program, or its L1 input window
has closed, when the ciphertext is empty or too large, or when the ciphertext does not re-commit to
`ciphertext_commitment`. It does **not** verify the ballot proof: Aztec does. A caller beyond the rate limit gets 429, an infrastructure
failure 503. The answer is

```json
{
  "input_id": "0x…",
  "encrypted_vote_hash": "0x…",
  "expires_at": 1760000000,
  "signature": "0x…64 bytes r||s, low-s",
  "signer": "0x…"
}
```

`signature` is an EIP-712 signature over `InputAvailability(uint256 e3Id, bytes32 inputId, uint64
expiresAt)` in the domain `("CRISP", "1", chainId, program)`, where `inputId` is the L1 program's
`keccak256(abi.encode("CRISP_INPUT_V1", program, e3Id, hash, commitment, slot, parentIndexPlusOne))`.
The bytes are durable before the signature is returned.

`GET /voting/remote-input/config` returns `kind`, `chain_id`, `program`, `aztec_node_url`,
`aztec_contract`, `signer` (address), `signer_public_key` (`x || y`, the key the Aztec contract is
deployed with), `staging_max_requests` (the limit a pass is proved for) and, when the server relays L1
registrations, `zkpassport_registrar`.

### Staging pass

The server attests availability before the `cast` (the contract requires the attestation), so without
a gate anyone could fill its storage with bytes that are never cast. Asking for the slot's signature
would let the server tell a vote (signed by the slot) from a mask (any registered slot may be masked
by anybody), which the ballot design keeps indistinguishable. A pass
(`extensions/core/circuits/staging_pass`, built by `extensions/aztec/sdk`'s `buildStagingPass`)
proves only that **the sender holds the key of some slot registered in the round's census**, and
reveals neither the slot nor the key:

- Public: `census_root`, `round_id` (the low 96 bits of the E3 id), `request_digest`, `max_requests`
  and a one-time `tag = Poseidon(x, y, round_id, k)` of the slot public key `(x, y)`.
- `request_digest = keccak256(abi.encode("CRISP_STAGING_V1", chainId, program, e3Id,
  ciphertextCommitment, slot, parentIndexPlusOne))` is signed by the slot key inside the proof, so a
  pass cannot be replayed for other bytes, another slot or another round.
- `k < max_requests`, so a slot key has `max_requests` tags per round (`STAGING_MAX_REQUESTS_PER_SLOT`,
  default 16). Every staging spends one, vote or mask. A mask is staged with the pass of the **masker's
  own** slot while the request names the masked slot; the server cannot tell. A voter who is not
  registered cannot stage.

The server checks, cheapest first: well-formed public inputs, the request digest recomputed from the
request and this round, `max_requests` equal to its own, `census_root` one the round has had, `tag` not
used in this round, then the proof (`bb verify`, 2 at a time, 30 s each), and finally stores the tag
atomically. Each refusal is a 400 naming the check. A tag stays spent when the request is refused for
what the caller sent (a closed window, bytes that do not match the commitment); a failure of the server
or of a chain it reads gives it back. Tags and census roots are dropped when the round is released.

The census roots come from the `MEMBER_REGISTERED` logs (tag `2`). A known root is answered at once. An
unknown one makes the server page the **proven** blocks from a saved cursor (never past the proven tip, as
the node replaces the blocks of an epoch that is never proven) and then read the unproven tail to the
newest block without saving a position, so a voter can stage right after registering. That read is single-flight per round and
runs at most once per 5 s: a pass naming a root registered within the last seconds may be refused
(`names a census root this round has not had`) and should be retried. This is anti-spam, not soundness:
`cast` checks the census itself. Before a proof is verified the server also refuses a proof of the wrong
size, a closed input window (round program and deadline cached per round) and a full staging store; at most
2 `bb verify` run at once and a request that waits more than 2 s for a slot gets 503. A pass is a ZK proof over the default `bb` target (`evm`: keccak transcript, zero knowledge); the
verification is a `bb` 6.0.0 subprocess because no workspace crate verifies UltraHonk, and a verifier
of our own would be a second implementation to keep in step with `bb`.

**Unlinkability assumption.** The tag hashes the slot *public key*, not the address, which the L1
registration and the census publish. The public key is never published: a ballot's signature is a
private input of its proof and the registration binds only the address. While that holds, tags cannot
be linked to slots, nor a vote's tag to a mask's. A slot owner who reveals a signature made with the key
(so anyone can recover it) can be linked to its tags, and so can anyone the server's logs of
`(tag, request)` pairs are shared with: the server learns which stagings used the same key, not whose.
The pass proves membership, not uniqueness of the person: it limits a key, and a registered voter with
several slots (documents) has several keys.

`POST /registration/l1` (404 unless `PROGRAM_KIND=aztec` and `ZKPASSPORT_REGISTRAR_ADDRESS` is set)

```json
{ "calldata": "0x…ZKPassportRegistrar.register(e3Id, slot, params, countries)" }
```

A round whose custom params name a `registrar` registers its voters on L1: the voter proves a
ZKPassport identity bound to the slot key, and the registrar sends the slot to Aztec as a MEMBER
message. The voter needs no Ethereum wallet; this route submits the calldata from the server key. It
forwards only `register` calldata (selector checked, arguments decoded) and only to the configured
registrar, and it simulates the call first: a refusal comes back as 400 with the registrar's error
(`DocumentAlreadyRegistered`, `AgeNotProven`, `NationalityNotProven`, `RegistrationClosed`, …) and
costs nothing; an unreachable node is 503; a caller past the rate limit gets 429. The answer is
`{ "txHash": "0x…" }` once the transaction is broadcast, not mined: a transaction that loses a race
(the same document registered twice at once) reverts on L1 and no MEMBER message follows. The server
key pays the gas. The registrar checks the proof binds the voter's slot and this chain, so nothing
the relay could alter redirects a registration.

`POST /voting/broadcast` returns 400 in this mode: inputs are not relayed to L1.

### Aztec log layout

`INPUT_COMMITTED` is a raw public log whose fields are `[1, round_id, index, slot, ciphertext_commitment,
vote_hash_hi (u128), vote_hash_lo (u128), parent_index_plus_one]`. The first field is the tag the
node indexes logs by, so it must stay the literal `1`. A log of another width or tag is refused
(`extensions/aztec/ingest/src/log.rs`).

`round_id` is the low 96 bits of the Interfold E3 id. A real E3 id is `interfold address (160 bits)
|| sequence (96 bits)`, above the BN254 modulus, so it does not fit an Aztec field. The ingest is
built with the Interfold address (`INTERFOLD_ADDRESS`) and maps each log to
`e3Id = interfold << 96 | round_id` before anything else sees it (`e3_id_of` / `round_id_of`); a log
whose `round_id` needs more than 96 bits is refused. The server, the round records, the
attestation's input id and its EIP-712 digest all use the full E3 id.

### Risks to know

- **Staged bytes are not ballot-backed.** The server cannot check the ballot proof, so a registered
  slot can stage up to `STAGING_MAX_REQUESTS_PER_SLOT` well-formed ciphertexts that are never cast; they
  stay until their round ends. The staging pass bounds this per slot key and shuts out everyone who is
  not registered; the allowance (`DATA_AVAILABILITY_MAX_PENDING_BYTES`) and the per-caller rate limit
  still bound the total. A census of N members can fill `N x max_requests` stagings.
- **One signer.** The attestation key is the server's `PRIVATE_KEY`. Rotating it requires a new
  Aztec deployment, and two servers cannot both serve one Aztec round: an input attested by one is
  unknown to the other, and that round would never reach `numInputs`.
- **Chain clocks.** `expires_at` is compared with the Aztec block time. A chain that has produced no
  block for a while lags the wall clock, so the server uses the later of the two before adding the
  TTL.

### Tests

```sh
cargo test -p crisp-remote-input -p crisp-aztec-ingest
cargo test -p crisp
```
