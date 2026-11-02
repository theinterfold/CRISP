# Working in CRISP

CRISP is a secret-ballot voting application on the Interfold: browser-encrypted ballots, Noir input
proofs, an OpenVM-proved tally program, and threshold decryption by Interfold ciphernodes. READMEs
own usage and public contracts; the nearest `AGENTS.md` owns change guidance; [RELEASING.md] owns
npm publication and deployment cutovers; [proof aggregation](docs/PROOF_AGGREGATION_AND_ZK.md) owns
local verification modes.

## Sources of authority

When sources disagree, use this descending order:

1. Deployed contract behavior, circuit statements, and the interfaces of the pinned Interfold
   release.
2. End-to-end and component tests.
3. Durable formats: signed server payloads, the server database, and published SDK/contracts pairs.
4. READMEs and docs that describe current behavior.

Correct documentation against higher-authority sources. Record unmet requirements as gaps rather
than weakening them to match code.

## Working agreement

- Preserve unrelated work. Confirm the checkout and branch before editing; coordinate concurrent
  work in separate, durable worktrees. Keep scratch files outside tracked source. The untracked
  `interfold/` directory is not a dependency; CRISP builds against the published release.
- Commit, push, open or publish PRs, mark them ready, merge, tag, publish packages, or deploy only
  when requested. Do not bypass failing checks; report failures and missing prerequisites.

## Development and style

- **KISS:** use the smallest cohesive solution. Avoid speculative frameworks, compatibility layers
  without callers, and unrelated cleanup.
- **SOLID:** give modules clear responsibilities and the interfaces their callers need. Extend the
  existing owner instead of copying a rule into the server, SDK, and client. Add abstractions for
  real boundaries, not symmetry.
- Fix protocol behavior in Interfold, not with CRISP-side workarounds; CRISP owns its ballot
  circuits, program, contracts, server, SDK, and client.
- Follow nearby code and repository formatter/linter configuration. Format changed files only. Write
  concise comments that explain why; match documentation style and preserve exact interface text.
- Keep READMEs and `AGENTS.md` focused on non-obvious usage, rationale, constraints, and operational
  hazards. Do not duplicate APIs, constants, file inventories, or behavior that is clear from code.
  Correct stale text instead of adding implementation summaries.

## Cross-component and release changes

- Ballot encoding, circuit public inputs, verifier keys, contract ABI/events, signed commitment
  payloads, and the program's tally semantics cross the circuits, SDK, zk-inputs, contracts,
  program, and server. Change them together and say so; a cleanup does not authorize changing them.
- Interfold release moves touch every pin listed in
  [Interfold dependency](Readme.md#interfold-dependency). Move them together and update the
  lockfiles and VK hash constants as that section describes.
- Use the canonical generators and scripts for verifiers, staged preset artifacts, VK hashes, and
  deployment records. Do not hand-patch generated output or restamp digests to silence a check.
- A mock verifier, mock data availability, skipped proof aggregation, or the unproved development
  runner is not evidence that the real path accepts a change.

## Verification

- Use root [package scripts](package.json); focused `cargo test -p`, `cargo check -p`, and
  `nargo test` are also supported. Start with the smallest covering check. Cross-component changes
  need `pnpm test:e2e`; proof changes need real-proof coverage, not only mocks.
- Test observable behavior at its owner boundary. A bug regression should fail before the fix and
  pass afterward. Avoid duplicate coverage, implementation-copying tests, and tests of instruction
  wording.
- Review the actual diff, correct documentation made false, and report commands, results, and
  verification limits. A successful compile is not proof verification or a successful CI run.

[RELEASING.md]: RELEASING.md
