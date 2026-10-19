#!/usr/bin/env bash
# Shared CRISP local dev configuration. Source from setup.sh / crisp_deploy.sh.

_crisp_dev_config_root() {
  (cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
}

load_crisp_dev_config() {
  CRISP_ROOT="$(_crisp_dev_config_root)"
  local cfg="${CRISP_ROOT}/crisp.dev.env"
  if [[ ! -f "$cfg" ]]; then
    cp "${CRISP_ROOT}/crisp.dev.env.example" "$cfg"
    echo "Created ${cfg} from crisp.dev.env.example"
  fi

  set -a
  # shellcheck disable=SC1090
  source "$cfg"
  set +a

  CRISP_BFV_PRESET="${CRISP_BFV_PRESET:-insecure-64}"
  CRISP_SKIP_PROOF_AGGREGATION="${CRISP_SKIP_PROOF_AGGREGATION:-true}"

  case "$CRISP_BFV_PRESET" in
    insecure-64)
      CRISP_E3_PARAM_SET=0
      ;;
    secure-8192)
      CRISP_E3_PARAM_SET=2
      ;;
    *)
      echo "Invalid CRISP_BFV_PRESET='${CRISP_BFV_PRESET}' (use insecure-64 or secure-8192)" >&2
      exit 1
      ;;
  esac

  case "$CRISP_SKIP_PROOF_AGGREGATION" in
    true | false) ;;
    *)
      echo "Invalid CRISP_SKIP_PROOF_AGGREGATION='${CRISP_SKIP_PROOF_AGGREGATION}' (use true or false)" >&2
      exit 1
      ;;
  esac

  if [[ "$CRISP_SKIP_PROOF_AGGREGATION" == "true" ]]; then
    unset ENABLE_ZK_VERIFICATION
  else
    export ENABLE_ZK_VERIFICATION=true
  fi
  export E3_NODES__CN1__SKIP_PROOF_AGGREGATION="$CRISP_SKIP_PROOF_AGGREGATION"
  export E3_NODES__CN2__SKIP_PROOF_AGGREGATION="$CRISP_SKIP_PROOF_AGGREGATION"
  export E3_NODES__CN3__SKIP_PROOF_AGGREGATION="$CRISP_SKIP_PROOF_AGGREGATION"
  export E3_NODES__CN4__SKIP_PROOF_AGGREGATION="$CRISP_SKIP_PROOF_AGGREGATION"
  export E3_NODES__CN5__SKIP_PROOF_AGGREGATION="$CRISP_SKIP_PROOF_AGGREGATION"

  # Local development runs the unproved development runner against a verifier that accepts every
  # receipt. The deployment allows that verifier on the isolated local chain, and on Sepolia only with
  # ALLOW_SEPOLIA_UNPROVED_COMPUTE=true. CRISP_REAL_PROOFS=1 uses the OpenVM worker configured
  # under program.openvm and deploys the real receipt verifier instead.
  CRISP_REAL_PROOFS="${CRISP_REAL_PROOFS:-0}"
  if [[ "$CRISP_REAL_PROOFS" == "1" ]]; then
    unset CRISP_UNPROVED_TEST E3_PROGRAM__DEV
  else
    export CRISP_UNPROVED_TEST=1
    export E3_PROGRAM__DEV=true
  fi

  export CRISP_BFV_PRESET CRISP_E3_PARAM_SET CRISP_SKIP_PROOF_AGGREGATION CRISP_ROOT CRISP_REAL_PROOFS
}

apply_crisp_dev_config_to_server_env() {
  local server_env="${CRISP_ROOT}/server/.env"
  if [[ ! -f "$server_env" ]]; then
    cp "${CRISP_ROOT}/server/.env.example" "$server_env"
  fi

  if grep -q '^E3_PARAM_SET=' "$server_env"; then
    sed -i.bak "s/^E3_PARAM_SET=.*/E3_PARAM_SET=${CRISP_E3_PARAM_SET}/" "$server_env"
    rm -f "${server_env}.bak"
  else
    printf '\n# 0=InsecureThreshold64, 2=SecureThreshold8192\nE3_PARAM_SET=%s\n' \
      "${CRISP_E3_PARAM_SET}" >> "$server_env"
  fi
}

# Installs the interfold CLI of the release that interfold-release.json pins into ~/.cargo/bin.
#
# The ciphernodes reject E3_NODES__CN*__SKIP_PROOF_AGGREGATION unless the binary carries the
# test-only-skip-proof-aggregation Cargo feature, so the binary has to follow the profile. The
# release publishes that build for Linux x86_64 only; on other platforms, and for a profile with no
# published build, the CLI is built from the release tag. Always reinstalling means that a binary
# from an earlier release or an earlier profile cannot survive.
install_interfold_cli() {
  local version platform asset="" archive features="" circuits_sha256
  version="$(node -p "require('${CRISP_ROOT}/interfold-release.json').version")"
  platform="$(uname -s)-$(uname -m)"
  if [[ "$CRISP_SKIP_PROOF_AGGREGATION" == "true" ]]; then
    features="--features test-only-skip-proof-aggregation"
    if [[ "$platform" == "Linux-x86_64" ]]; then
      asset="interfold-test-only-skip-proof-aggregation-linux-x86_64.tar.gz"
    fi
  else
    case "$platform" in
      Linux-x86_64) asset="interfold-linux-x86_64.tar.gz" ;;
      Darwin-arm64) asset="interfold-macos-aarch64.tar.gz" ;;
    esac
  fi

  mkdir -p "${HOME}/.cargo/bin"
  if [[ -n "$asset" ]]; then
    echo "Installing the interfold ${version} CLI from the release (${asset})..."
    archive="$(node "${CRISP_ROOT}/scripts/interfold-release.mjs" asset "$asset")"
    tar -xzf "$archive" -C "${HOME}/.cargo/bin" interfold
    return 0
  fi

  echo "Building the interfold ${version} CLI from its release tag (${features:-no extra features})..."
  # A release build of the CLI pins the SHA-256 of its circuit archive, which `interfold noir setup`
  # checks. The pin comes from the release workflow, so a build from the tag takes it from here.
  circuits_sha256="$(node -p "require('${CRISP_ROOT}/interfold-release.json').sha256['circuits-${version}.tar.gz']")"
  # shellcheck disable=SC2086
  E3_CIRCUITS_ARCHIVE_SHA256="$circuits_sha256" cargo install --locked \
    --git https://github.com/theinterfold/interfold --tag "v${version}" --bin interfold -f $features e3-cli
}

print_crisp_dev_config_summary() {
  cat <<EOF

CRISP dev profile (${CRISP_ROOT}/crisp.dev.env):
  CRISP_BFV_PRESET=${CRISP_BFV_PRESET}
  E3_PARAM_SET=${CRISP_E3_PARAM_SET}
  CRISP_SKIP_PROOF_AGGREGATION=${CRISP_SKIP_PROOF_AGGREGATION}
  ENABLE_ZK_VERIFICATION=${ENABLE_ZK_VERIFICATION:-false} (used at deploy via dev:up)
  ciphernode skip flag=${CRISP_SKIP_PROOF_AGGREGATION}
  Contract addresses synced by dev:up (deploy → server/.env, client/.env, interfold.config.yaml)

EOF
}
