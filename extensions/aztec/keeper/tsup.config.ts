// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/main.ts'],
  format: ['esm'],
  clean: true,
  sourcemap: true,
  banner: { js: '#!/usr/bin/env node' },
  // The Aztec stack ships its own wasm and workers; it is resolved at run time through @crisp-e3/aztec.
  external: [/^@aztec-labs\//, /^@aztec-foundation\//, /^@crisp-e3\//, /^@zkpassport\//],
})
