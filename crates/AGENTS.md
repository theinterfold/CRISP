# Working on the Rust crates

These crates adapt the pinned Interfold `e3-*` libraries for CRISP. `zk-inputs` builds ballot
witnesses, `zk-inputs-wasm` exposes them to
[`@crisp-e3/zk-inputs`](../packages/crisp-zk-inputs/AGENTS.md), `crisp-utils` decodes tallies, and
`evm_helpers` wraps the CRISP and Interfold contracts for the server. The server consumes
`crisp-utils` and `evm_helpers`. The [Interfold dependency](../Readme.md#interfold-dependency)
section owns the pin.

- The witness JSON from `zk-inputs` is a contract with the Noir circuits in `circuits/` and with
  `e3-zk-witness`/`e3-zk-config` at the pinned tag. Field names, limb order (descending, centered),
  the zero limbs and zero commitment for an empty slot, and which addend `keep_previous` selects
  must stay in step with the circuit. A mismatch can still compile, and a wrong commitment proves
  fine but is rejected on chain, because the digest the contract rebuilds differs from the signed
  one. Do not move an `e3-*` tag here without moving every pin together.
- `zk-inputs` only accepts parameter tuples that match a threshold preset with a built circuit. The
  wasm constructor passes no error variance, and `fromPreset` selects a preset by name. Changing
  accepted presets or the default set changes which circuits and artifacts apply.
- `MAX_MSG_NON_ZERO_COEFFS` in `crisp-utils` is duplicated in the SDK constants and comes from
  `interfold_lib` in Noir. Change them together; no check ties the values.
- `evm_helpers` reads Interfold's frozen ciphertext verifier by recomputing an ERC-7201 storage slot
  and the layout order of `CiphertextVerifierStorage`. Contract storage and ABI changes break it
  without a compile error, so re-derive the slot against the pinned Interfold contracts.
- `fold_key_hash` is run by `scripts/compute_vk_hash.sh`, whose output is pasted into the fold
  circuits. Changing the argument order or hash encoding silently changes the circuits' expected key
  hash.

Check a change with `cargo test -p zk-inputs`, `cargo test -p crisp-utils`, or
`cargo test -p evm-helpers` (the integration test starts Anvil, which needs Foundry installed), and
`pnpm -C packages/crisp-zk-inputs build` for the wasm crate. CI runs a workspace `cargo test` for
the whole workspace, so run that before reporting a change to a type the server shares. These checks
do not prove a witness verifies under Noir, that a proof is accepted on chain, or that `evm_helpers`
matches a live deployment; use the circuit tests (`pnpm test:circuits`) and `pnpm test:e2e` for
that.
