// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.
pragma solidity >=0.8.27;

/// @notice The entry point the AMB calls on both ends of a CRISP Gnosis round.
/// @dev The AMB `_data` is `abi.encodeCall(IGnosisReceiver.receiveMessage, (message))`, where `message` is one of the
/// `CRISPGnosisMessages` / `CRISPRemoteMessages` layouts. Implemented by `CrispGnosisVoting` (kinds 1, 2, 4) and
/// `CRISPGnosisProgram` (kind 3).
interface IGnosisReceiver {
  function receiveMessage(bytes calldata message) external;
}
