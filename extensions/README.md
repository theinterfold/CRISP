# CRISP extensions

CRISP rounds whose voters live on another chain (an L2) while Interfold, the committee and the compute stay on Ethereum. The
voter-facing chain collects registrations and ballots and builds the input tree; Ethereum only receives the tree root when the
input window closes. The poll creator still makes a single L1 transaction (`Interfold.request`).

```mermaid
sequenceDiagram
    participant C as Poll creator
    participant L1 as L1 remote program
    participant L2 as L2 CRISP contract
    participant V as Voter
    participant K as Keeper
    participant S as CRISP server
    C->>L1: Interfold.request (validate sends ROUND)
    K->>L2: open round (consume ROUND)
    K->>L1: publishCommitteeKey (sends KEY) after KeyPublished
    K->>L2: publish key (consume KEY)
    V->>L2: register (identity proof)
    V->>S: stage ciphertext with a staging pass, get availability attestation
    V->>L2: cast (ballot proof + attestation), leaf appended
    K->>L2: close round (sends ROOT)
    K->>L1: submit root (consume ROOT)
    S->>S: ingest L2 inputs, compute when indexed == numInputs
    S->>L1: publishCiphertextOutput (verify binds proof root to the L2 root)
```

## Layout

| Path | Role |
| --- | --- |
| `core/contracts` | `CRISPRemoteProgram`: chain-agnostic L1 E3 program; `CRISPRemoteMessages`: ROUND/KEY/ROOT layouts. |
| `core/remote-input` | Rust crate `crisp-remote-input`: the server seam (`RemoteInputSource`, `InputRootSubmitted`, gating, availability attester, staging pass statement). |
| `core/circuits/staging_pass` | Noir circuit of the staging pass: an anonymous, rate-limited proof that the sender holds the key of some slot of the round's census, required to stage a ciphertext (see `core/README.md`). |
| `core/circuits/staging_pass_votes` | Noir circuit of the staging pass of the votes kind: the same ticket keyed by a per-round staging secret bound for each enrolled governance slot, since a wallet's public key is public (see `core/README.md`). |
| `aztec/` | Reference extension for Aztec v6 (see `aztec/README.md`). |
| `gnosis/` | Token-weighted votes on Gnosis Chain over the AMB, executed by a Safe (see `gnosis/README.md`). |

## Adding an L2

A new chain adds a sibling `extensions/<l2>/` with: an **L1 adapter** extending `CRISPRemoteProgram` (see `core/README.md`); an **L2
contract** that reproduces `CRISPProgram`'s input tree byte for byte, verifies the three base ballot proofs (no fold) and the server's
availability attestation, enforces the slot parent chain, window, limit and replay rules, and emits inputs and the census root after
each registration in a form the server can index; a **server ingest** crate implementing `crisp_remote_input::RemoteInputSource`
(`fetch_inputs`, `census_roots`, `latest_timestamp`) plus a `ProgramKind` variant, after which the server reuses the shared
`AvailabilityAttester` and compute path unchanged; and an **SDK and keeper** for voter transactions and the permissionless relays. The
OpenVM guest, program server and CRISP circuits are shared by every extension and must not change for one chain.
