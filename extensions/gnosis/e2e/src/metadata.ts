// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

// Serves the proposal metadata the keeper reads: `GET /<cid>` returns `<dir>/<cid>.json`. Stands in for IPFS.
import { existsSync, readFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join } from 'node:path'

const dir = process.env.METADATA_DIR!
const port = Number(process.env.METADATA_PORT)

createServer((request, response) => {
  const cid = (request.url ?? '').slice(1)
  const file = join(dir, `${cid}.json`)
  if (!/^[\w-]+$/.test(cid) || !existsSync(file)) {
    response.writeHead(404).end()
    return
  }
  response.writeHead(200, { 'content-type': 'application/json' }).end(readFileSync(file))
}).listen(port, '127.0.0.1')
