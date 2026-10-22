#!/usr/bin/env bash
# SPDX-License-Identifier: LGPL-3.0-only
#
# Prints the key hash that each fold circuit binds for one BFV preset:
# `compute_vk_hash.sh [insecure-64|secure-8192]`, insecure-64 by default.
#
#   compute_vk_hash(user_data_encryption, ballot, user_data_encryption_ct0, user_data_encryption_ct1)
#
# Both stacks import the generated circuits/lib/src/fold_anchors.nr module. The normal compiler
# refreshes it after building the ballot leaves and before compiling either fold.
#
# The ballot hash changes whenever the ballot circuit changes, and the user_data_encryption hashes
# change with the Interfold release that interfold-release.json pins.
set -euo pipefail

CRISP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PRESET="${1:-insecure-64}"
cd "$CRISP"

bash scripts/compile_circuits.sh "$PRESET"
node scripts/fold-anchors.mjs "$PRESET" --live --check
