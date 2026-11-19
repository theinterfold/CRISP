# `@crisp-e3/gnosis`

TypeScript client for CRISP proposals voted on Gnosis Chain (Chiado) with Interfold on Sepolia. The
contracts are [`../contracts`](../contracts); ballots and proofs reuse `@crisp-e3/sdk`.

```ts
import { setCircuits } from '@crisp-e3/sdk'
import { loadCircuits } from '@crisp-e3/sdk/insecure-64' // or secure-8192: the round's preset
import { buildRequest, castBallot, claimFaucet, getConfig, getProposalStatus, packBatch, quoteFee, requestRound } from '@crisp-e3/gnosis'

const config = await getConfig(serverUrl) // addresses, voting chain id, faucet
await claimFaucet(serverUrl, voter) // demo token, delegated to the voter, before a proposal is requested

// proposer (Sepolia wallet): the batch is bound by its hash
const { packed, proposalHash } = packBatch([{ to: token, data: transferCalldata }])
const request = buildRequest({ program, inputStart, inputEnd, proposalHash, metadataCid, feeToken, cryptoConfigId, maxFee, committeeSize, paramSet })
request.maxFee = await quoteFee(sepolia, interfold, request)
const { e3Id } = await requestRound(sepoliaWallet, sepolia, interfold, request)

// voter (any wallet, no gas on the voting chain): one EIP-712 signature
setCircuits(await loadCircuits())
await castBallot({ serverUrl, e3Id, voting, chainId: config.chain_id, chiado, wallet, choice: OPTION.FOR })
// or with part of the voting power (ballot units, at most `votingPowerOf`): the chain still sees the full power
await castBallot({ serverUrl, e3Id, voting, chainId: config.chain_id, chiado, wallet, choice: OPTION.FOR, weight: power / 4n })

const { phase, round, result } = await getProposalStatus({ sepolia, chiado, interfold, program, voting, module, e3Id })
```

`src/abi/*.ts` are generated from `../contracts/abi/*.json` (`pnpm gen:abi`). `tests/messages.test.ts` checks the
message encoders against `../contracts/test/fixtures/message-vectors.json`, which the Foundry suite writes from the
Solidity encoders.

## Build and test

```bash
pnpm -C packages/crisp-sdk build
pnpm -C extensions/gnosis/sdk build test typecheck
pnpm -C extensions/gnosis/sdk pack --pack-destination <dir>   # tarball for an app outside the workspace
```
