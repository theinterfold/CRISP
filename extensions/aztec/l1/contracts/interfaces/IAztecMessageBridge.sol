// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.
pragma solidity >=0.8.27;

/// @notice The slice of Aztec's `DataStructures` (aztec-packages v6.0.0, `l1-contracts/src/core/libraries/DataStructures.sol`)
/// that CRISP uses. Field order and types are the ABI the deployed Inbox and Outbox expect.
library AztecDataStructures {
  /// @param actor The Aztec address of the actor.
  /// @param version The rollup version the actor lives on.
  struct L2Actor {
    bytes32 actor;
    uint256 version;
  }

  struct L1Actor {
    address actor;
    uint256 chainId;
  }

  struct L2ToL1Msg {
    L2Actor sender;
    L1Actor recipient;
    bytes32 content;
  }
}

/// @notice L1 -> L2 side of the Aztec message bridge (`IInbox`, v6.0.0).
interface IAztecInbox {
  /// @notice Insert a message for `_recipient`; returns its leaf in the L1-to-L2 tree and its leaf index.
  /// @dev `_content` and `_secretHash` must be BN254 field elements (<= p - 1).
  function sendL2Message(
    AztecDataStructures.L2Actor memory _recipient,
    bytes32 _content,
    bytes32 _secretHash
  ) external returns (bytes32, uint256);

  /// @notice The rollup version this Inbox serves.
  function VERSION() external view returns (uint256);
}

/// @notice L2 -> L1 side of the Aztec message bridge (`IOutbox`, v6.0.0).
interface IAztecOutbox {
  /// @notice Consume an L2 -> L1 message. Only the message's recipient may call it. `Epoch` is a `uint256`.
  function consume(
    AztecDataStructures.L2ToL1Msg calldata _message,
    uint256 _epoch,
    uint256 _numCheckpointsInEpoch,
    uint256 _leafIndex,
    bytes32[] calldata _path
  ) external;

  /// @notice The rollup version this Outbox serves.
  function VERSION() external view returns (uint256);
}
