// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { loadConfig } from './config'
import { Keeper } from './keeper'

const log = (message: string) => console.log(`${new Date().toISOString()} ${message}`)

const keeper = await Keeper.start(loadConfig(process.env), log)
const stopping = new AbortController()
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.once(signal, () => stopping.abort())

await keeper.run(stopping.signal)
