// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.
pragma solidity >=0.8.27;

import { CRISPRemoteMessages } from "@crisp-e3/extension-core/contracts/CRISPRemoteMessages.sol";

/// @notice Exposes the internal message encoders so tests can pin their bytes against `tests/fixtures/message-vectors.json`.
contract MessageVectorsHarness {
  function round(CRISPRemoteMessages.RoundConfig calldata config) external pure returns (bytes memory) {
    return CRISPRemoteMessages.round(config);
  }

  function committeeKey(uint256 roundId, bytes32 key) external pure returns (bytes memory) {
    return CRISPRemoteMessages.committeeKey(roundId, key);
  }

  function inputRoot(uint256 roundId, uint256 root, uint256 numInputs) external pure returns (bytes memory) {
    return CRISPRemoteMessages.inputRoot(roundId, root, numInputs);
  }
}
