// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.
pragma solidity 0.8.28;

import { IOpenVmReceiptVerifier } from "@interfold/contracts/contracts/interfaces/IOpenVmReceiptVerifier.sol";

/// @notice Accepts a receipt only when its journal digest is the one the test expects, so a test observes exactly
/// which journal `CRISPRemoteProgram.verify` built.
contract MockOpenVmReceiptVerifier is IOpenVmReceiptVerifier {
  bytes32 public constant imageId = keccak256("CRISP_REMOTE_TEST_COMPUTE_RECEIPT");
  bytes32 public expectedJournalDigest;

  error UnexpectedJournalDigest(bytes32 actual, bytes32 expected);

  function setExpectedJournalDigest(bytes32 journalDigest) external {
    expectedJournalDigest = journalDigest;
  }

  function verify(bytes calldata, bytes32, bytes32 journalDigest) external view override {
    if (journalDigest != expectedJournalDigest) revert UnexpectedJournalDigest(journalDigest, expectedJournalDigest);
  }
}
