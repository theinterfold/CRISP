#!/usr/bin/env bash
# SPDX-License-Identifier: LGPL-3.0-only
#
# Compile the staging pass and write what its consumers load into `compiled/`:
#   staging_pass.json  the circuit, without debug symbols (loaded by `@crisp-e3/aztec`)
#   staging_pass.vk    the verification key (loaded by the CRISP server, baked into its image)
# Needs nargo 1.0.0-rc.3 (as `circuits/`) and bb 6.0.0 (the version the server verifies with).
# The key is for bb's default target (`evm`: keccak transcript, zero knowledge).
set -euo pipefail
cd "$(dirname "$0")"

nargo compile
mkdir -p compiled
jq 'del(.debug_symbols, .file_map)' target/staging_pass.json > compiled/staging_pass.json
bb write_vk -b target/staging_pass.json -t evm -o target/vk_out
mv target/vk_out/vk compiled/staging_pass.vk
