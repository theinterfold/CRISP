// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { defineConfig } from 'tsup'

export default defineConfig({
  // Two entries with shared chunks, so that a class is the same object whichever entry it comes from.
  entry: ['src/index.ts', 'src/passport.ts'],
  format: ['esm'],
  dts: true,
  clean: true,
  sourcemap: true,
  // The Aztec stack and the CRISP SDK ship their own wasm and workers; bundling them would break both.
  external: [/^@aztec-labs\//, /^@aztec-foundation\//, /^@crisp-e3\//, /^@zkpassport\//],
})
