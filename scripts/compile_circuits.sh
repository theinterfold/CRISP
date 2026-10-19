#!/usr/bin/env bash

set -euo pipefail

# Compiles the CRISP circuits for one BFV preset: `compile_circuits.sh [insecure-64|secure-8192]`,
# insecure-64 by default. The script runs from the CRISP repository root.
#
# The user_data_encryption circuits are not compiled here. They come compiled from the Interfold
# release that interfold-release.json pins (`node scripts/interfold-release.mjs circuits`).
CRISP_CIRCUITS="circuits"
PRESET="${1:-insecure-64}"

case "$PRESET" in
    insecure-64) PRESET_MODULE="insecure" ;;
    secure-8192) PRESET_MODULE="secure" ;;
    *)
        echo "Usage: compile_circuits.sh [insecure-64|secure-8192]" >&2
        exit 1
        ;;
esac

# The preset is a compile-time choice of the CRISP library. With insecure-64, this writes the file
# that the repository holds.
cat >"$CRISP_CIRCUITS/lib/src/preset.nr" <<EOF
// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

//! The BFV preset that the CRISP circuits compile against.
//!
//! \`scripts/compile_circuits.sh <preset>\` rewrites this file. The committed file selects
//! insecure-64, the preset for local development and pull-request CI.

pub use interfold_lib::configs::${PRESET_MODULE}::threshold;
EOF

# The generated verifiers are NOT preset-specific. They are written from the fold circuit's
# verification key, and the fold circuit takes the inner key as an input and checks its hash against
# either preset's constant, so its own structure carries no BFV degree. Compiling both presets
# produces byte-identical verifiers; one directory is correct.
VERIFIER_DIR="packages/crisp-contracts/contracts/verifiers"
mkdir -p "$VERIFIER_DIR"

# Two ballot stacks share the same user_data_encryption dependencies and differ only in how a
# round establishes eligibility:
#
#   crisp         + fold         -> CRISPVerifier.sol         (census Merkle tree)
#   crisp_onchain + fold_onchain -> CRISPOnchainVerifier.sol  (voting power read on chain)
#
# Each row is "crisp package dir : fold package dir : fold package name : verifier file name".
STACKS=(
    "crisp:fold:crisp_fold:CRISPVerifier.sol"
    "crisp_onchain:fold_onchain:crisp_onchain_fold:CRISPOnchainVerifier.sol"
)

# Apply project-specific checks that the generated verifier does not emit.
patch_verifier() {
    local verifier_path="$1"

    python3 - "$verifier_path" <<'PY'
from pathlib import Path
import sys

path = Path(sys.argv[1])
text = path.read_text()

replacements = [
    (
        "bytes4 internal constant FRLIB_MODEXP_FAILED_SELECTOR = 0xf8d61709;",
        "bytes4 internal constant FRLIB_MODEXP_FAILED_SELECTOR = 0x1f7ec5f0;",
    ),
    (
        "    error ConsistencyCheckFailed();",
        "    error ConsistencyCheckFailed();\n    error VerificationKeyConfigurationMismatch();",
    ),
    (
        "    proofLength += NUM_ELEMENTS_COMM * 3; // Libra concat, grand sum, quotient comms + Gemini masking",
        "    proofLength += NUM_ELEMENTS_COMM * 3; // Libra concat, grand sum, quotient comms",
    ),
    (
        """    constructor(uint256 _N, uint256 _logN, uint256 _vkHash, uint256 _numPublicInputs) {
        $N = _N;
        $LOG_N = _logN;
        $VK_HASH = _vkHash;
        $NUM_PUBLIC_INPUTS = _numPublicInputs;
        $MSMSize = NUMBER_UNSHIFTED_ZK + _logN + LIBRA_COMMITMENTS + 2;
    }
""",
        """    constructor(uint256 _N, uint256 _logN, uint256 _vkHash, uint256 _numPublicInputs) {
        $N = _N;
        $LOG_N = _logN;
        $VK_HASH = _vkHash;
        $NUM_PUBLIC_INPUTS = _numPublicInputs;
        $MSMSize = NUMBER_UNSHIFTED_ZK + _logN + LIBRA_COMMITMENTS + 2;
    }

    function validateVerificationKey(Honk.VerificationKey memory vk) internal view {
        require($N == vk.circuitSize, Errors.VerificationKeyConfigurationMismatch());
        require($LOG_N == vk.logCircuitSize, Errors.VerificationKeyConfigurationMismatch());
        require($NUM_PUBLIC_INPUTS == vk.publicInputsSize, Errors.VerificationKeyConfigurationMismatch());
    }
""",
    ),
    (
        """contract HonkVerifier is BaseZKHonkVerifier(N, LOG_N, VK_HASH, NUMBER_OF_PUBLIC_INPUTS) {
     function loadVerificationKey() internal pure override returns (Honk.VerificationKey memory) {
""",
        """contract HonkVerifier is BaseZKHonkVerifier(N, LOG_N, VK_HASH, NUMBER_OF_PUBLIC_INPUTS) {
    constructor() {
        validateVerificationKey(HonkVerificationKey.loadVerificationKey());
    }

    function loadVerificationKey() internal pure override returns (Honk.VerificationKey memory) {
""",
    ),
]

for old, new in replacements:
    if text.count(old) != 1:
        raise SystemExit(f"expected one generated verifier match, found {text.count(old)}: {old[:80]}")
    text = text.replace(old, new)

path.write_text(text)
PY
}

for stack in "${STACKS[@]}"; do
    IFS=":" read -r crisp_dir fold_dir fold_pkg verifier_file <<<"$stack"
    crisp_target="${CRISP_CIRCUITS}/bin/${crisp_dir}/target"

    echo "Compiling ${crisp_dir} circuit..."
    if ! (cd "$CRISP_CIRCUITS/bin/${crisp_dir}" && nargo compile); then
        echo "Error: ${crisp_dir} circuit compilation failed"
        exit 1
    fi

    echo "Writing noir-recursive-no-zk VK for ${crisp_dir}..."
    if ! bb write_vk -b "${crisp_target}/${crisp_dir}.json" -o "${crisp_target}" -t noir-recursive-no-zk; then
        echo "Error: bb write_vk (noir-recursive-no-zk) failed for ${crisp_dir}"
        exit 1
    fi
    mv "${crisp_target}/vk" "${crisp_target}/${crisp_dir}.vk_recursive"
    mv "${crisp_target}/vk_hash" "${crisp_target}/${crisp_dir}.vk_recursive_hash"

    echo "Compiling ${fold_dir} circuit (verifies user_data_encryption + ${crisp_dir})..."
    if ! (cd "$CRISP_CIRCUITS/bin/${fold_dir}" && nargo compile); then
        echo "Error: ${fold_dir} circuit compilation failed"
        exit 1
    fi

    # Generate verifier from fold circuit (on-chain proof verifies the folded proof)
    echo "Generating ${fold_dir} Verifier Key..."
    if ! bb write_vk -b "$CRISP_CIRCUITS/bin/${fold_dir}/target/${fold_pkg}.json" -o "$CRISP_CIRCUITS/bin/${fold_dir}/target" --oracle_hash keccak; then
        echo "Error: Failed to generate ${fold_dir} Verifier Key"
        exit 1
    fi

    echo "Generating Solidity Verifier ${verifier_file}..."
    if ! bb write_solidity_verifier -k "$CRISP_CIRCUITS/bin/${fold_dir}/target/vk" -o "$CRISP_CIRCUITS/bin/${fold_dir}/target/${verifier_file}"; then
        echo "Error: Failed to generate Solidity Verifier ${verifier_file}"
        exit 1
    fi

    echo "Copying ${verifier_file} to contracts folder..."
    if ! cp "$CRISP_CIRCUITS/bin/${fold_dir}/target/${verifier_file}" "${VERIFIER_DIR}/${verifier_file}"; then
        echo "Error: Failed to copy ${verifier_file} to contracts folder"
        exit 1
    fi

    # Add the correct license header
    echo "Adding license header to ${verifier_file}..."
    LICENSE_HEADER="// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE."
    # Remove the first 2 lines (Apache license and copyright) and prepend our license header
    TEMP_FILE=$(mktemp)
    {
        echo "$LICENSE_HEADER"
        tail -n +3 "${VERIFIER_DIR}/${verifier_file}"
    } >"$TEMP_FILE"
    mv "$TEMP_FILE" "${VERIFIER_DIR}/${verifier_file}"

    patch_verifier "${VERIFIER_DIR}/${verifier_file}"

    echo "Formatting ${verifier_file} with Prettier..."
    if pnpm exec prettier --write "${VERIFIER_DIR}/${verifier_file}" 2>/dev/null; then
        echo "Prettier formatting complete"
    else
        echo "Warning: Prettier formatting skipped (run pnpm install from repo root if needed)"
    fi
done

echo "Noir setup completed successfully"
