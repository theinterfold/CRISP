#!/usr/bin/env bash

set -e

# Keep this test independent of a developer's server/.env. The voting window must remain open
# through committee formation, DKG, wallet reconnection, and encrypted-vote proof generation.
export E3_DURATION="${CRISP_E2E_DURATION_SECS:-300}"

# The wallet is injected into the page by test/fixtures/injectedWallet.ts, so the browser runs
# headless on every platform with no extension or display server.
PLAYWRIGHT_CMD="pnpm playwright test"

echo "TEST E2E SCRIPT STARTING..."
# The client starts only after the ciphernodes are running and registered, which takes about 3
# minutes in CI. A start that takes 15 minutes fails here, not at the CI job's timeout.
pnpm concurrently -krs command-1 ./scripts/dev.sh "wait-on --timeout 900000 tcp:3000 file:./.interfold/ready && ${PLAYWRIGHT_CMD}"
