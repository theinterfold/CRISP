// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.
pragma solidity >=0.8.27;

/// @notice Safe's `MultiSend` / `MultiSendCallOnly`: executes a packed batch of transactions.
/// @dev Each transaction is packed as `operation (1 byte) | to (20) | value (32) | dataLength (32) | data`.
interface IMultiSend {
  function multiSend(bytes memory transactions) external payable;
}
