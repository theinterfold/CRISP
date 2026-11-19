# CRISP on Gnosis Chain

Gasless, private, token-weighted DAO votes whose result a Safe executes. Interfold, the committee and the compute stay on
Sepolia; ballots are cast on Gnosis Chain (Chiado) and the two talk over the Gnosis AMB. A proposal is a Safe batch: its hash is
fixed when the round is requested, and only that batch can run if the vote passes.

```mermaid
sequenceDiagram
    participant P as Proposer
    participant L1 as CRISPGnosisProgram (Sepolia)
    participant AMB as Gnosis AMB
    participant G as CrispGnosisVoting (Chiado)
    participant S as CRISP server
    participant K as Keeper
    participant M as CrispGovernanceModule, Delay, Safe
    P->>L1: Interfold.request (validate sends ROUND with proposalHash)
    AMB->>G: ROUND opens the round
    K->>L1: publishCommitteeKey (KEY), AMB delivers it
    Note over G,S: voter: ballot proof + EIP-712 signature, the server relays publishInput (no voter gas)
    K->>G: closeRound (ROOT), getSignatures, executeSignatures on Sepolia
    S->>L1: compute and decrypt the tally
    K->>L1: relayResult (RESULT), AMB delivers the tally
    K->>M: executeProposal (quorum, approval) queues the batch; executeNextTx after the cooldown
```

Voting power is `getPastVotes` of an ERC20Votes token at the round's snapshot. Weights, voters and turnout are public; only the
choices are hidden, so a small electorate with a few large holders leaks most of a result. Ballot signers must be EOAs (the proof
checks an ECDSA signature).

## Layout

| Path | Role |
| --- | --- |
| `contracts/` (Foundry) | `CRISPGnosisProgram` (Sepolia adapter: AMB transport, proposer allowlist, `relayResult`), `CRISPGnosisMessages` (the 14-word ROUND and the RESULT layout), `CrispGnosisVoting` (Chiado: weights, the ballot verifier, the input tree), `CrispGovernanceModule` (Zodiac: checks the delivered tally, queues the batch in the Delay), `CrispDemoToken` (ERC20Votes with a faucet), Delay v1.1.1, `MockAMB`. `abi/` holds the ABIs the SDK, keeper and server read. |
| `ingest/` | Rust crate `crisp-gnosis-ingest`: the server's `RemoteInputSource` for the voting contract. |
| `sdk/` | `@crisp-e3/gnosis`: message codecs, Safe batch packing, ballot building and signing, the server client, round readers. |
| `keeper/` | Relays KEY, closes rounds, carries ROOT, relays RESULT, queues and executes passed proposals. |
| `e2e/` | One full proposal on a local anvil (see `e2e/README.md`). |

The server side is `PROGRAM_KIND=gnosis` (`server/.env.example`, `server/Readme.md`).

## Passing rule

A proposal passes when `for + against + abstain >= quorum` (token units) and `for * 10000 > (for + against) * approvalBps`; a tie
fails. Weights are rounded down to ballot units, so turnout can sit just under the quorum.

## Commands

```sh
cd extensions/gnosis/contracts && forge test
pnpm -C extensions/gnosis/sdk test
pnpm -C extensions/gnosis/keeper test
cargo test -p crisp-gnosis-ingest
pnpm test:e2e:gnosis                      # up, one proposal, down
```

## Deploying

Four steps, because the program and the voting contract name each other:

1. `contracts/script/DeploySepolia.s.sol` (`PROPOSER` required): `CRISPGnosisProgram`, with the proposer allowed.
2. `contracts/script/DeployChiado.s.sol` (`PROGRAM`, `INPUT_SIGNER` required): the voting contract, the demo token, the Safe,
   the Delay and the module. Optional: `QUORUM`, `APPROVAL_BPS`, `DELAY_COOLDOWN`, `DELAY_EXPIRATION`, `FAUCET`, `FAUCET_AMOUNT`,
   `FAUCET_COOLDOWN`, `TREASURY`.
3. `contracts/script/SetRemote.s.sol` (`PROGRAM`, `VOTING`): one-shot.
4. The Interfold owner calls `registerE3Program(program)`, then the program owner `bindInterfold(interfold)`.

`deployments/{sepolia,chiado}.json` record the addresses. The AMB's Chiado to Sepolia leg is not automatic: the keeper calls
`getSignatures` on the AMB helper (`0x3cc500B3c01D04C265c9293cB35BA2Fd8eA6dc1b`) and `executeSignatures` on Sepolia.
