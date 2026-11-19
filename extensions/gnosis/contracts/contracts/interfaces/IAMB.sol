// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.
pragma solidity >=0.8.27;

/// @notice The part of the Gnosis Arbitrary Message Bridge (AMB) that CRISP calls.
/// @dev Signatures as deployed on Sepolia (Foreign) and Chiado (Home): `requireToPassMessage(address,bytes,uint256)` is
/// `0xdc8601b3`. Messages that fail on the receiving side are not replayable, so receivers must not revert on an
/// authentic message.
interface IAMB {
  /// @notice Send `data` to `executor` on the other chain, to be executed with `gasLimit` gas.
  /// @return messageId The bridge's id of the message.
  function requireToPassMessage(address executor, bytes calldata data, uint256 gasLimit) external returns (bytes32 messageId);

  /// @notice The sender, on the other chain, of the message being executed. Zero outside a message execution.
  function messageSender() external view returns (address);

  /// @notice The most gas a message sent from this side may ask for.
  function maxGasPerTx() external view returns (uint256);
}
