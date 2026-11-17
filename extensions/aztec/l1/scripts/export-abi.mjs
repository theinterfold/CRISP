// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

// Writes `abi/CRISPAztecProgram.json` (the ABI the SDK, keeper and server consume) from the compiled artifact.
// `tests/abi.test.ts` fails when the tracked file drifts from the contract.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'

const artifact = JSON.parse(
  readFileSync(new URL('../artifacts/contracts/CRISPAztecProgram.sol/CRISPAztecProgram.json', import.meta.url), 'utf8'),
)
mkdirSync(new URL('../abi/', import.meta.url), { recursive: true })
writeFileSync(new URL('../abi/CRISPAztecProgram.json', import.meta.url), `${JSON.stringify(artifact.abi, null, 2)}\n`)
