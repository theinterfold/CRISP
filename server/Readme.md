# CRISP Server

This is a Rust-based server implementation for CRISP, which is built on top of the Interfold
Protocol, which handles E3 (Encrypted Execution Environment) rounds and voting processes.

## Features

- Create and manage voting rounds (E3 rounds)
- Secure vote casting using FHE
- Real-time blockchain event handling and processing
- OpenVM program-service integration and verified HTTP callbacks
- CLI for manual interaction

## Prerequisites

- Rust (latest stable version)
- Cargo (Rust's package manager)
- Foundry (for deploying contracts)
- Anvil (for local testnet)

## Setup

1. Install dependencies:

   ```
   cargo build --locked --release
   ```

2. Set up environment variables: Create a `.env` with the following content:

   ```
   PRIVATE_KEY=your_private_key
   HTTP_RPC_URL=your_http_rpc_url
   WS_RPC_URL=your_websocket_rpc_url
   INTERFOLD_ADDRESS=your_interfold_contract_address
   E3_PROGRAM_ADDRESS=your_e3_program_address
   CIPHERNODE_REGISTRY_ADDRESS=your_ciphernode_registry_address
   FEE_TOKEN_ADDRESS=free_token_address
   CHAIN_ID=your_chain_id
   INTERFOLD_SERVER_URL=https://your_crisp_server_url
   CRON_API_KEY=your_cron_api_key
   ```

   `CRON_API_KEY` must be nonempty when you run the cron client or expose `POST /rounds/request`.
   Both paths fail closed when the secret is absent or blank. Do not embed this key in a browser
   bundle. The cron client and SDK round-request method require HTTPS for remote servers and reject
   redirects. Plain HTTP is accepted only for `localhost`, `127.0.0.0/8`, and `[::1]` development
   endpoints.

   In Avail mode, the server schedules the input window after `CRISPProgram.earliestVotingStart()`.
   `VOTING_START_BUFFER_SECONDS` adds mining time before that fixed start. `E3_DURATION` then covers
   the voting interval and the Avail finalization interval; it does not include VRF, ticket
   submission, or DKG.

## Running the Server

1. Start the crisp server:

   ```
   cargo run --bin server
   ```

2. To start the E3 cron job that requests new rounds every 24 hours, run:
   ```
   cargo run --bin cron
   ```

## Using the CLI

To interact with the CRISP system using the CLI:

```
cargo run --bin cli
```

Follow the prompts to initialize new E3 rounds, activate rounds, participate in voting, or decrypt
and publish results.

## API Endpoints

The server exposes several RESTful API endpoints:

- `GET /rounds/current`: Get the current round information
- `POST /rounds/public-key`: Get the public key for a specific round
- `POST /rounds/ciphertext`: Get the ciphertext for a specific round
- `POST /rounds/request`: Request a new E3 round (protected by API key). The server key is the
  requester, so it pays the E3 fee in the Interfold fee token. Before each request the server quotes
  the fee and, if its allowance to Interfold is short, approves exactly the quoted fee. The key
  needs a fee-token balance, but no manual `approve`.
- `POST /state/result`: Get the result for a specific round
- `GET /state/all`: Get results for all rounds
- `POST /state/lite`: Get a lite version of the state for a specific round
- `POST /voting/broadcast`: Broadcast an encrypted vote
- `POST /voting/remote-input`, `GET /voting/remote-input/config`: only with `PROGRAM_KIND=aztec`; they stage a ciphertext against
  a staging pass and sign an availability attestation. The server needs `STAGING_PASS_VK_PATH` and `BB_BINARY_PATH` (`bb` 6.0.0;
  the Docker image ships both). In that mode `/voting/broadcast` and `/rounds/request` refuse. See `../extensions/aztec/README.md`.
- With `PROGRAM_KIND=gnosis` (ballots on `CrispGnosisVoting`, see `../extensions/gnosis/README.md`):
  - `POST /voting/broadcast` `{round_id, encoded_proof, send_from_wallet?}` checks the ballot with an `eth_call` of
    `validateInputProof`, signs the availability attestation and relays `publishInput`. It returns `success` with `tx_hash`, or
    `ready_for_commitment` with `encoded_proof` for the voter's wallet when the relay is off, over its limits or out of funds, or
    `send_from_wallet` is set. A refused or already-sent ballot is a 400.
  - `GET /voting/remote-input/config` returns the chain, the contracts, the attestation signer and the faucet, with
    `GNOSIS_PUBLIC_RPC_URL` as `rpc_url`.
  - `POST /faucet` `{address}` (only with `FAUCET_ENABLED=true`) mints the voting token from `FAUCET_PRIVATE_KEY`, limited per
    caller, per address and by the token's cooldown.
  - The indexer reads inputs from the voting contract's `InputCommitted` logs, and the voting token's delegates from chain logs.

## Sharing aggregate ciphertexts between servers (mock data availability)

With `DATA_AVAILABILITY_MODE=mock`, ciphernodes with `mode: mock_http` read every E3 output from one
CRISP server's `/availability` route. A server whose program that route's server does not run must
get its output there too:

- The receiving server sets `EXTERNAL_OUTPUTS_MAX_BYTES` (at least one object, 1 MiB). It then accepts
  `PUT /availability/objects/<0x keccak256>?e3_id=<decimal id>` with the raw bytes as the body, and stores them only if Interfold
  holds that hash as the output of an E3 in `CiphertextReady`, before its decryption deadline. It answers 200 when it stored the
  object or already holds it.
- The sending server (any `PROGRAM_KIND`, including `aztec` and `gnosis`) sets `EXTERNAL_OUTPUT_UPLOAD_URL` to the receiver's
  route, for example `https://private-crisp.theinterfold.com/availability`. The URL must be http(s) and the mode `mock`, or the
  server does not start. Once Interfold references the output of a round, the server sends the exact bytes to
  `{url}/objects/0x<keccak256>?e3_id=<id>`.

The upload is a durable obligation of the output job: every published output without a finished upload is sent again after a
restart. A transient failure (a connection error, a 5xx, 408, 409, 425 or 429) retries after 30 s, doubling to at most 10 min,
until the E3's decryption deadline passes, which the server reads from Interfold as the receiver does. A final refusal (any other
status, including a redirect, which is never followed) is logged as an error and not retried. An unset variable uploads nothing.
The result of each upload is kept in the `data-availability-output-uploads` tree of the server database.

## Upgrading across an input-format change

`InputPublished` and the durable round record both carry per-input fields, and both have changed. A
deployment that adds one cannot be rolled forward over a round that is already taking inputs:

- the event's topic hash changes with its signature, so the indexer no longer matches the logs an
  already-deployed `CRISPProgram` emits;
- the new per-input vectors default to empty when an existing round is loaded, and the Secure
  Process needs one entry per ciphertext.

`CrispE3Repository::get_input_snapshot` refuses such a round rather than computing over it, with an
error naming the field and the count. The refusal is the guard, not the fix.

**Procedure.** Deploy a new `CRISPProgram`, point `E3_PROGRAM_ADDRESS` at it, and let existing
rounds finish against the old deployment before retiring its indexer. Rounds do not migrate: an
in-flight one has inputs whose leaves were built under the old layout, so its root can only be
reproduced by the code that built it.

## Architecture

The project is structured into several modules:

- `cli`: Command-line interface for interacting with the system
- `server`: Main server implementation
- `blockchain`: Handlers for blockchain events and interactions
- `models`: Data structures used throughout the application
- `routes`: API endpoint implementations
- `database`: Database operations for storing and retrieving E3 round data
