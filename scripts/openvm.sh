#!/usr/bin/env bash
# SPDX-License-Identifier: LGPL-3.0-only
#
# CRISP's OpenVM tasks. The OpenVM workers (`crates/openvm-prover`) and the interfold CLI build in
# the interfold repository: run `pnpm openvm prover-build` and `pnpm openvm cli-build` there.
set -euo pipefail
CRISP="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
command="${1:-}"
shift || true
case "$command" in
  fixture)
    export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$CRISP/target/openvm/crisp-server}"
    exec cargo run --locked --release --manifest-path "$CRISP/Cargo.toml" -p e3-user-program --example openvm_fixture -- "$@"
    ;;
  crisp-server-build|crisp-server-test)
    export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$CRISP/target/openvm/crisp-server}"
    exec cargo "${command#crisp-server-}" --locked --manifest-path "$CRISP/Cargo.toml" -p crisp "$@"
    ;;
  # CRISP's program runner: runner/, which serves the proving service.
  service-build|service-check)
    exec cargo "${command#service-}" --locked --manifest-path "$CRISP/Cargo.toml" -p e3-user-program-runner "$@"
    ;;
  # Builds CRISP's guest, keys, receipt identity, worker configuration and program runner, with the
  # compile script of the interfold submodule. Takes the same OPENVM_* environment as
  # `interfold program compile`.
  compile)
    cd "$CRISP"
    exec bash "$CRISP/interfold/crates/cli/scripts/openvm-compile.sh" "$@"
    ;;
  service-start)
    cd "$CRISP"
    export OPENVM_PROVER_CONFIG="${OPENVM_PROVER_CONFIG:-$CRISP/.interfold/caches/openvm/prover.json}"
    exec cargo run --release --bin program-runner -- openvm
    ;;
  # Builds CRISP's guest and runs it, without proving, on a fixture made by `fixture`, then checks
  # that it reveals the SHA-256 digest of the journal the native host computed.
  guest-parity)
    fixture="${1:?Usage: pnpm openvm guest-parity <fixture-directory>}"
    out="$CRISP/target/openvm/guest-parity"
    export OPENVM_BUILD_LOCKED=1
    RUSTFLAGS="${RUSTFLAGS:-} --cfg crisp_openvm --cfg crisp_fhe_optimized" \
      cargo openvm build --manifest-path "$CRISP/guest/Cargo.toml" --target-dir "$out/target" --output-dir "$out"
    revealed="$(cargo openvm run --manifest-path "$CRISP/guest/Cargo.toml" --exe "$out/e3-openvm-guest.vmexe" \
      --input "$fixture/execute/input.json" | sed -n 's/^Execution output: //p')"
    expected="$(python3 -c 'import hashlib, sys; print(list(hashlib.sha256(open(sys.argv[1], "rb").read()).digest()))' \
      "$fixture/execute/journal.bin")"
    if [ "$revealed" != "$expected" ]; then
      echo "The guest revealed ${revealed:-nothing}; the host journal hashes to $expected" >&2
      exit 1
    fi
    echo "The guest revealed the digest of the host's journal"
    ;;
  # `cargo openvm <arguments>` in CRISP's guest, with the guest's configuration flags.
  guest)
    export RUSTFLAGS="${RUSTFLAGS:-} --cfg crisp_openvm --cfg crisp_fhe_optimized"
    export OPENVM_BUILD_LOCKED=1
    cd "$CRISP/guest"
    exec cargo openvm "$@"
    ;;
  contract-test)
    exec pnpm --filter @crisp-e3/contracts test --network default tests/openvm-receipt.test.ts tests/crisp.journal.test.ts "$@"
    ;;
  proof-test)
    OPENVM_REQUIRE_PROOF_TEST=1 exec pnpm --filter @crisp-e3/contracts test --network default tests/openvm-proof.test.ts "$@"
    ;;
  service-e2e)
    OPENVM_E2E_ENABLED=1 exec pnpm --filter @crisp-e3/contracts test --network localhost tests/openvm-service.test.ts "$@"
    ;;
  *) echo 'Usage: pnpm openvm fixture|crisp-server-build|crisp-server-test|service-build|service-check|compile|service-start|guest-parity|guest|contract-test|proof-test|service-e2e [arguments]' >&2; exit 2 ;;
esac
