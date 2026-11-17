// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

// Writes `abi/CRISPAztecProgram.json` and `abi/ZKPassportRegistrar.json` (the ABIs the SDK, keeper and server consume)
// from the compiled artifacts. `tests/abi.test.ts` fails when a tracked file drifts from its contract.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const artifacts = {
  CRISPAztecProgram: '../artifacts/contracts/CRISPAztecProgram.sol/CRISPAztecProgram.json',
  ZKPassportRegistrar: '../artifacts/@crisp-e3/extension-core/contracts/ZKPassportRegistrar.sol/ZKPassportRegistrar.json',
}
mkdirSync(new URL('../abi/', import.meta.url), { recursive: true })
for (const [name, artifact] of Object.entries(artifacts)) {
  const { abi } = JSON.parse(readFileSync(new URL(artifact, import.meta.url), 'utf8'))
  writeFileSync(new URL(`../abi/${name}.json`, import.meta.url), `${JSON.stringify(abi, null, 2)}\n`)
}
