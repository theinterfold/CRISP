// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.
pragma solidity >=0.8.27;

/// @title CRISPAztecVotesMessages
/// @notice L1 -> L2 messages of {CRISPAztecVotesProgram}; mirrored by the Noir contract and the SDK.
/// @dev KEY and ROOT are `CRISPRemoteMessages.committeeKey` / `.inputRoot`.
library CRISPAztecVotesMessages {
  uint256 internal constant KIND_ROUND = 1;
  uint256 internal constant KIND_ENROLL = 4;

  /// @notice ROUND: `abi.encode(1, roundId, numOptions, inputStart, inputEnd, inputLimit)`.
  function round(
    uint256 roundId,
    uint256 numOptions,
    uint256 inputStart,
    uint256 inputEnd,
    uint256 inputLimit
  ) internal pure returns (bytes memory) {
    return abi.encode(KIND_ROUND, roundId, numOptions, inputStart, inputEnd, inputLimit);
  }

  /// @notice ENROLL: `abi.encode(4, roundId, uint256(uint160(slot)), weight)`.
  function enroll(uint256 roundId, address slot, uint256 weight) internal pure returns (bytes memory) {
    return abi.encode(KIND_ENROLL, roundId, uint256(uint160(slot)), weight);
  }
}
