#!/usr/bin/env bash
# SPDX-License-Identifier: LGPL-3.0-only
#
# Prints the key hash that each fold circuit binds for one BFV preset:
# `compute_vk_hash.sh [insecure-64|secure-8192]`, insecure-64 by default.
#
#   compute_vk_hash(user_data_encryption, ballot, user_data_encryption_ct0, user_data_encryption_ct1)
#
# Each hash belongs in the matching fold circuit, under the constant of the preset:
#   crisp         -> circuits/bin/fold/src/main.nr         CRISP_FOLD_EXPECTED_KEY_HASH_*
#   crisp_onchain -> circuits/bin/fold_onchain/src/main.nr CRISP_ONCHAIN_FOLD_EXPECTED_KEY_HASH_*
#
# The ballot hash changes whenever the ballot circuit changes, and the user_data_encryption hashes
# change with the Interfold release that interfold-release.json pins.
set -euo pipefail

CRISP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PRESET="${1:-insecure-64}"
cd "$CRISP"

bash scripts/compile_circuits.sh "$PRESET"
INTERFOLD="$(node scripts/interfold-release.mjs circuits)"

for ballot in crisp crisp_onchain; do
  printf '%s %s: ' "$PRESET" "$ballot"
  cargo run --quiet --locked --release -p zk-inputs --bin fold_key_hash -- \
    "$INTERFOLD/user_data_encryption.vk_recursive_hash" \
    "circuits/bin/${ballot}/target/${ballot}.vk_recursive_hash" \
    "$INTERFOLD/${PRESET}/user_data_encryption_ct0.vk_recursive_hash" \
    "$INTERFOLD/${PRESET}/user_data_encryption_ct1.vk_recursive_hash"
done
