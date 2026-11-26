# CRISP on Aztec

Voters register with ZKPassport and cast CRISP ballots on Aztec v6; Interfold, the committee and the compute stay on Ethereum.
The poll creator makes one L1 transaction (`Interfold.request`); voter transactions are paid by Aztec's SponsoredFPC; every relay
step is permissionless (`keeper/`). See `../README.md` for the cross-chain flow.

| Path | Contents |
| --- | --- |
| `l1/` | `CRISPAztecProgram`: Inbox (ROUND, KEY) and Outbox (ROOT) adapter over `CRISPRemoteProgram`. |
| `contracts/` | aztec-nr `CrispAztec`: ZKPassport registration (age, nationality), census LeanIMT, ballot verification, input LazyIMT, close. Vendored ZKPassport Aztec verifier/registry. |
| `sdk/` | `@crisp-e3/aztec`: voter client, deploy, L1 helpers, round rules and nationality commitments, log readers, generated bindings. |
| `keeper/` | Relay service: open round, relay and publish key, close round, submit root. |
| `ingest/` | Rust crate the CRISP server uses to read `INPUT_COMMITTED` logs. |
| `e2e/` | Full-round harness on the Aztec local network (`pnpm test:e2e:aztec`) and mock-document ZKPassport proof tooling. |

## Registration and nationality

The creator sets the round's rules in the custom parameters of `Interfold.request`:

```
abi.encode(uint256 numOptions, uint256 credits, uint256 minAge, bool allowMockDocuments,
           uint8 nationalityMode, string[] countries, uint256 nationalityCommitment)
```

`@crisp-e3/aztec` encodes and decodes it (`encodeCustomParams` / `decodeCustomParams`). `minAge` is 0 (no rule) to 99.
`nationalityMode` is 0 none, 1 the voter's nationality is in `countries`, 2 it is not (ICAO alpha-3 codes such as `DEU`, at most
200). `nationalityCommitment` is 0 without a nationality rule and non-zero with one. Only the creator needs an Ethereum wallet.

The voter submits the ZKPassport proof from an Aztec account (fees by SponsoredFPC) to `CrispAztec.register*`, which verifies it
in private and inserts the slot into the census; the SDK's `client.register` picks the entry point that fits the round's rules.
See `contracts/README.md` for the entry points and the nationality commitment.

## Design constraints

- **Round ids.** Aztec and the L1↔L2 messages key rounds by `roundId = e3Id & (2^96 - 1)` (an Interfold e3Id exceeds the BN254
  field); the contract rebuilds the full e3Id for the EIP-712 digests and `inputId`, which equal the L1 CRISP ones.
- **Trees.** The input tree is byte-identical to `CRISPProgram`'s, so the OpenVM guest and program server are unchanged. circom
  Poseidon costs ~271k L2 gas per hash, which caps both trees at 65,536 leaves.
- **Ballot proof.** The voter proves only the two base circuits and `cast` verifies them (`contracts/README.md`). They are
  private arguments of `cast`, must be proved client-side and **must never leave the voter's device**.
- **Identity.** ZKPassport `compressed` outer proofs (bb 6.0.0, circuits release 0.23.0) are verified in the private `register*`
  functions, bound to the caller and scoped per round: one registration per document per round, so a person with two documents
  can register twice.
- **Availability.** Ciphertexts stay off-chain: the server stages them against a **staging pass** and signs an `InputAvailability`
  attestation that `cast` verifies, as on L1.
- **Finality.** The ROOT message is consumable on L1 only after the Aztec epoch proof; deployments set `remoteFinalityWindow`.

## Server

The CRISP server runs Aztec rounds with `PROGRAM_KIND=aztec`. One instance serves one program: `E3_PROGRAM_ADDRESS` is the
`CRISPAztecProgram` and the server does not serve L1 CRISP rounds. The chain-agnostic seam is `extensions/core/remote-input`
(crate `crisp-remote-input`); the Aztec side is `extensions/aztec/ingest` (crate `crisp-aztec-ingest`); the integration is in
`server/src/server/{indexer/remote_input.rs,data_availability/remote_input.rs}`.

| Variable                        | Meaning                                                                                                   |
| ------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `PROGRAM_KIND`                  | `crisp` (default), `aztec`, or `aztec-votes` (see below).                                                 |
| `E3_PROGRAM_ADDRESS`            | The `CRISPAztecProgram` (L1). It is the `verifyingContract` of the availability attestation.              |
| `AZTEC_NODE_URL`                | Aztec node JSON-RPC. Required.                                                                            |
| `AZTEC_CONTRACT_ADDRESS`        | The `CrispAztec` contract, 32 bytes hex. Required.                                                        |
| `AZTEC_ATTESTATION_TTL_SECONDS` | Validity of an attestation, counted from the later of the Aztec and the local clock. Default 900.         |
| `AZTEC_START_BLOCK`             | First Aztec block scanned for inputs. Unset scans from the first block.                                   |
| `STAGING_PASS_VK_PATH`          | Verification key of the staging pass circuit (`extensions/core/circuits/staging_pass/compiled/staging_pass.vk`). Required. |
| `STAGING_MAX_REQUESTS_PER_SLOT` | Staging passes one slot key may use per round: its ciphertext stagings, votes and masks together. Default 16. |
| `BB_BINARY_PATH`                | The Barretenberg CLI that verifies passes, `bb` 6.0.0 exactly (checked at startup). Default `bb` on the `PATH`; the Docker image ships it. |
| `BB_CRS_PATH`                   | `bb`'s reference-string directory. Unset: `~/.bb-crs`, which `bb` fills from the internet on first use. The Docker image ships it. |
| `PRIVATE_KEY`                   | Signs the attestations. The Aztec contract must be deployed with its public key (`GET /voting/remote-input/config`). |

The server relays no inputs in this mode (`POST /voting/broadcast` and `/rounds/request` return 400); outside local chains
`RELAY_MIN_BALANCE_ETH=0` satisfies the relay validation.

### `PROGRAM_KIND=aztec-votes`

The votes program has the same Aztec ingest (its input logs are identical), but its staging pass is `staging_pass_votes`: it proves
membership of a bound staging key, so `STAGING_PASS_VK_PATH` is `extensions/core/circuits/staging_pass_votes/compiled/staging_pass_votes.vk`,
and the roots a pass may name are read from the `STAGING_KEY_BOUND` logs (tag 6) of any block, not from the census. Inputs are still
read from proven blocks only. The server also serves `POST /voting/remote-input/enroll` (`server/Readme.md`), which relays the permissionless
L1 `enroll` so voters need no gas. `GET /voting/remote-input/config` answers `kind: "aztec-votes"`.

### Round life cycle

The server starts a round when the committee key is indexed (no census, no Merkle root). Every 5 seconds it reads the
`INPUT_COMMITTED` logs and pairs each with the bytes it staged; only blocks of a proven epoch are read (`toBlock = proven + 1`),
because the node drops the unproven blocks of an epoch that is never proven and reuses their numbers. An input whose bytes the
server never staged stops ingestion of that round. On `InputRootSubmitted(e3Id, inputRoot, numInputs)`, once it holds exactly
`numInputs` inputs, it rebuilds the tree, computes only if the root equals `inputRoot` and continues as an L1 CRISP round.

### Endpoints

`POST /voting/remote-input` (404 unless `PROGRAM_KIND=aztec`). `round_id` is the full Interfold E3 id (decimal), not the
contract's 96-bit round id.

The body is `{ round_id, slot, ciphertext, ciphertext_commitment, parent_index_plus_one, staging_pass: { proof, public_inputs } }`
(hex strings). It answers 400 when the staging pass is refused, the round is unknown, belongs to another program or has a closed input window, or
the ciphertext is empty, too large, or does not re-commit to `ciphertext_commitment`; 429 beyond the rate limit; 503 on an
infrastructure failure. It does **not** verify the ballot proof: Aztec does. The answer is `{ input_id, encrypted_vote_hash,
expires_at, signature (64 bytes r||s, low-s), signer }`: an EIP-712 signature over `InputAvailability(uint256 e3Id, bytes32 inputId,
uint64 expiresAt)` in the domain `("CRISP", "1", chainId, program)`, with the L1 program's `inputId`.

`GET /voting/remote-input/config` returns the program, chain and contract, the `signer` and `signer_public_key` (`x || y`, the key
the Aztec contract is deployed with) and `staging_max_requests`.

### Staging pass

The server attests availability before the `cast`, so without a gate anyone could fill its storage with bytes that are never cast,
and asking for the slot's signature would let it tell a vote from a mask. A pass (`extensions/core/circuits/staging_pass`, built by
the SDK's `buildStagingPass`) proves that **the sender holds the key of some slot registered in the round's census**, revealing
neither slot nor key. Its public inputs are `census_root`, `round_id`, `request_digest` (signed by the slot key, so a pass cannot
be replayed for other bytes), `max_requests` and a one-time `tag` of the slot public key and a counter `k < max_requests`. Every
staging, vote or mask, spends one tag; a mask is staged with the masker's own slot's pass.

The server checks the public inputs, `max_requests`, a known `census_root` and a fresh `tag`, then the proof (`bb verify`). A tag
stays spent when the request is refused for what the caller sent. Census roots come from the `MEMBER_REGISTERED` logs: a pass naming
a root registered within the last seconds may be refused (`names a census root this round has not had`) and should be retried.
Tags are unlinkable to slots only while the slot public key stays unpublished; the pass limits a key, not a person.

The `INPUT_COMMITTED` log layout is in `contracts/README.md`; its first field is the tag and must stay the literal `1`. The ingest
is built with `INTERFOLD_ADDRESS` and maps each log's 96-bit `round_id` to the full `e3Id`.

### Risks to know

- **Staged bytes are not ballot-backed**: a registered slot can stage up to `STAGING_MAX_REQUESTS_PER_SLOT` ciphertexts that are
  never cast; they stay until the round ends. `DATA_AVAILABILITY_MAX_PENDING_BYTES` and the per-caller rate limit bound the total.
- **One signer.** The attestation key is the server's `PRIVATE_KEY`. Rotating it requires a new Aztec deployment, and two servers
  cannot both serve one Aztec round.
- **Chain clocks.** `expires_at` is compared with the Aztec block time, which lags the wall clock on an idle chain; the server uses
  the later of the two before adding the TTL.

### Tests

```sh
cargo test -p crisp-remote-input -p crisp-aztec-ingest
cargo test -p crisp
```
