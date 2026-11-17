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
- **Ballot proof.** The final fold proof uses the `noir-recursive` target (ZK, 458 fields) and is
  verified in the private `cast` with `verify_honk_proof` against the stored fold VK hash.
- **Identity.** A round registers its voters on one of two paths, chosen by its creator (see
  *Registration paths and nationality* below). On the Aztec path, ZKPassport `compressed` outer
  proofs (bb 6.0.0) are verified in the private `register*` functions, bound to the caller, scoped
  per round; one registration per document per round. On the L1 path the L1 `ZKPassportRegistrar`
  verifies the proof and the slot reaches Aztec as a MEMBER message. Either way a person holding two
  documents can still register twice.
- **Availability.** Ciphertexts stay off-chain: the CRISP server stages them and signs an
  `InputAvailability` attestation that `cast` verifies, as on L1.
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
| `PRIVATE_KEY`                   | Signs the attestations. The Aztec contract must be deployed with its public key (see `config` below).    |

The server relays no inputs in this mode (it only relays L1 registrations, below). Outside local chains, `RELAY_MIN_BALANCE_ETH=0` satisfies the
relay validation.

### Round life cycle

1. **Request.** The poll creator requests the round on L1. The server decodes the program's custom
   parameters, `abi.encode(numOptions, credits, minAge, allowMockDocuments, registrar, nationalityMode,
   countries, nationalityCommitment)`, records the round, and starts it when the committee key is
   indexed. It has no census and posts no Merkle root;
   `/rounds/request` refuses in this mode.
2. **Voting.** The voter encrypts a ballot, sends the ciphertext to `POST /voting/remote-input`, and
   submits the returned attestation with the Noir proof to Aztec. Aztec verifies the proof and
   accepts the input.
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
  "parent_index_plus_one": 0
}
```

The server computes `keccak256(ciphertext)` itself. It refuses the request (400) when the round is
unknown, belongs to another program, or its L1 input window has closed, when the ciphertext is empty
or too large, or when the ciphertext does not re-commit to `ciphertext_commitment`. It does **not**
verify the ballot proof: Aztec does. A caller beyond the rate limit gets 429, an infrastructure
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
deployed with) and, when the server relays L1 registrations, `zkpassport_registrar`.

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

- **Staged bytes are not proof-backed.** The server cannot check a Noir proof, so any caller can stage
  well-formed ciphertexts until the staging allowance (`DATA_AVAILABILITY_MAX_PENDING_BYTES`) or the
  per-caller rate limit is hit, and the bytes stay until their round ends. The allowance is shared
  with no other path, but a full allowance blocks honest staging for that period.
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
