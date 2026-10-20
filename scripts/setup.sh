#!/usr/bin/env bash

set -e

export CARGO_INCREMENTAL=1

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${SCRIPT_DIR}/lib/dev_config.sh"

load_crisp_dev_config

echo "SETUP..."
echo "pnpm install (crisp)"
(cd "${CRISP_ROOT}" && pnpm install --frozen-lockfile)
echo "sdk"
(pnpm build:sdk)
echo "evm"
(pnpm compile:contracts)
echo "server"
(cd ./server && [[ ! -f .env ]] && cp .env.example .env; cargo build --locked --bin cli && cargo build --locked --bin server)
apply_crisp_dev_config_to_server_env
echo "client"
(cd ./client && if [[ ! -f .env ]]; then cp .env.example .env; fi)
echo "ciphernode"
install_interfold_cli

# Real proofs need the OpenVM guest, its keys and receipt identity before the deployment reads them.
if [[ "$CRISP_REAL_PROOFS" == "1" ]]; then
  echo "Compiling the OpenVM guest, keys, and proving service..."
  (cd "${CRISP_ROOT}" && interfold program compile)
fi

print_crisp_dev_config_summary
