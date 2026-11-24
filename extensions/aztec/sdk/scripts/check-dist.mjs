// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

// Refuse to publish a build that cannot load. Each entry inlines a compiled Aztec contract and reads it when it
// is imported, which throws for an artifact that `aztec compile` did not transpile (a build made from a member
// directory of the contracts workspace, or with `aztec-nargo compile`).

for (const entry of ['index', 'passport']) {
  await import(new URL(`../dist/${entry}.js`, import.meta.url).href)
}
console.log('@crisp-e3/aztec: both entries of the build load')
