// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { readFileSync } from 'node:fs'
import { expect } from 'chai'
import { artifacts } from 'hardhat'

describe('exported ABI', function () {
  for (const name of ['CRISPAztecProgram']) {
    it(`abi/${name}.json matches the compiled contract (run \`pnpm export:abi\`)`, async function () {
      const { abi } = await artifacts.readArtifact(name)
      const tracked = JSON.parse(readFileSync(new URL(`../abi/${name}.json`, import.meta.url), 'utf8'))
      expect(tracked).to.deep.equal(abi)
    })
  }
})
