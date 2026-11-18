// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.
pragma solidity >=0.8.27;

/// @notice Byte layouts of the messages exchanged between a CRISP L1 program and its L2 contract.
/// @dev Chain-agnostic: an adapter only decides how these bytes travel (the Aztec adapter hashes them into a
/// field element, another L2 may deliver them as-is). The L2 contract and every off-chain encoder
/// (`extensions/aztec/sdk`) hand-copy these layouts, so a change here is a protocol change.
/// Every word is a full 32-byte ABI word and the first word is the message kind.
library CRISPRemoteMessages {
  /// @notice L1 -> L2: configuration of a round, sent while the round is requested.
  uint256 internal constant KIND_ROUND = 1;
  /// @notice L1 -> L2: the committee public key of a round.
  uint256 internal constant KIND_KEY = 2;
  /// @notice L2 -> L1: the root and size of the round's input tree.
  uint256 internal constant KIND_ROOT = 3;

  /// @dev Word 2 of every message is the round id (`CRISPRemoteProgram.remoteRoundId`: the low 96 bits of the E3 id): a
  /// full E3 id does not fit a field element.
  struct RoundConfig {
    uint256 roundId;
    uint256 numOptions;
    uint256 credits;
    uint256 inputStart;
    uint256 inputEnd;
    uint256 inputLimit;
    uint256 scopeHash;
    uint256 minAge;
    bool allowMockDocuments;
    /// @dev 0 none, 1 nationality in a list, 2 nationality not in a list.
    uint256 nationalityMode;
    /// @dev ZKPassport's Poseidon2 commitment of the country list the L2 checks proofs against; non-zero iff
    /// `nationalityMode != 0`.
    uint256 nationalityCommitment;
  }

  /// @notice `abi.encode(1, roundId, numOptions, credits, inputStart, inputEnd, inputLimit, scopeHash, minAge, allowMockDocuments,
  /// nationalityMode, nationalityCommitment)`: 12 words.
  function round(RoundConfig memory config) internal pure returns (bytes memory) {
    return
      abi.encode(
        KIND_ROUND,
        config.roundId,
        config.numOptions,
        config.credits,
        config.inputStart,
        config.inputEnd,
        config.inputLimit,
        config.scopeHash,
        config.minAge,
        config.allowMockDocuments ? uint256(1) : uint256(0),
        config.nationalityMode,
        config.nationalityCommitment
      );
  }

  /// @notice `abi.encode(2, roundId, committeePublicKey)`.
  function committeeKey(uint256 roundId, bytes32 committeePublicKey) internal pure returns (bytes memory) {
    return abi.encode(KIND_KEY, roundId, committeePublicKey);
  }

  /// @notice `abi.encode(3, roundId, inputRoot, numInputs)`.
  function inputRoot(uint256 roundId, uint256 root, uint256 numInputs) internal pure returns (bytes memory) {
    return abi.encode(KIND_ROOT, roundId, root, numInputs);
  }
}
