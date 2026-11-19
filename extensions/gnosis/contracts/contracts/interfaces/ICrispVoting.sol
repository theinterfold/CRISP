// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.
pragma solidity >=0.8.27;

/// @notice The round and result records of `CrispGnosisVoting`, and the part of it the governance module reads.
interface ICrispVoting {
  /// @notice A round as opened by the ROUND message.
  /// @dev All times are Chiado timestamps. `inputEnd == 0` means the round does not exist; `committeeKey == 0` means the
  /// KEY message has not arrived, so no ballot is accepted yet.
  struct Round {
    uint256 inputStart;
    uint256 inputEnd;
    uint256 inputLimit;
    uint256 numOptions;
    /// @dev The timepoint voting power is read at: the Sepolia request timestamp minus one, clamped to `clock() - 1`.
    uint256 snapshot;
    /// @dev Raw token voting power per ballot unit: `getPastTotalSupply(snapshot) / plaintextModulus + 1`.
    uint256 divisor;
    uint256 plaintextModulus;
    bytes32 committeeKey;
    bytes32 proposalHash;
    address requester;
    bool closed;
    uint256 numInputs;
    string metadataCid;
  }

  /// @notice The decrypted tally of a round, stored once when the RESULT message arrives.
  struct Result {
    bool resolved;
    uint64 resolvedAt;
    /// @dev Option 0 = For, 1 = Against, 2 = Abstain; each in ballot units (multiply by `divisorOf` for token wei).
    uint256[] tally;
  }

  function roundOf(uint256 roundId) external view returns (Round memory);

  function resultOf(uint256 roundId) external view returns (Result memory);

  function proposalHashOf(uint256 roundId) external view returns (bytes32);

  function divisorOf(uint256 roundId) external view returns (uint256);
}
