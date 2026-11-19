// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { log } from './proc'
import { round } from './round'
import { down, up } from './stack'

const usage = `usage: tsx src/run.ts <command>

  up      deploy the stacks and start ciphernodes, program server, CRISP server and keeper
  round   run one full round against a running stack and assert its tally
  down    stop everything and restore the repo files the deploy scripts rewrote
  all     up, round, down (down also runs when a step fails; set CRISP_E2E_KEEP=1 to leave the stack up)
`

const main = async () => {
  const command = process.argv[2]
  switch (command) {
    case 'up':
      await up()
      break
    case 'down':
      await down()
      break
    case 'round':
      await round()
      break
    case 'all': {
      let failed = false
      try {
        await up()
        await round()
      } catch (error) {
        failed = true
        console.error(error)
      } finally {
        if (process.env.CRISP_E2E_KEEP === '1') log('CRISP_E2E_KEEP=1: leaving the stack up')
        else await down()
      }
      if (failed) process.exitCode = 1
      break
    }
    default:
      console.error(usage)
      process.exitCode = 2
  }
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (error) => {
    console.error(error)
    process.exit(1)
  },
)
