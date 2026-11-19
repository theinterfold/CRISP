// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

// Writes `abi/<Name>.json` (plain ABI arrays: the ABI the SDK, keeper, server and app consume) from the `forge build`
// artifacts. `pnpm test` (`test/AbiDrift.t.sol`) fails when a tracked file drifts from its contract.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const contracts = ['CrispGnosisVoting', 'CRISPGnosisProgram', 'CrispGovernanceModule', 'CrispDemoToken', 'IAMB', 'MockAMB']
mkdirSync(new URL('../abi/', import.meta.url), { recursive: true })
for (const name of contracts) {
  const { abi } = JSON.parse(readFileSync(new URL(`../out/${name}.sol/${name}.json`, import.meta.url), 'utf8'))
  writeFileSync(new URL(`../abi/${name}.json`, import.meta.url), `${JSON.stringify(abi, null, 2)}\n`)
}
