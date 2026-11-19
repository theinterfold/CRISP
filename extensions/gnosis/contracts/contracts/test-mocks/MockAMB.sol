// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.
pragma solidity >=0.8.27;

import { IAMB } from "../interfaces/IAMB.sol";

/// @notice Local stand-in for one end of the Gnosis AMB. Deploy two: one with `isHome = true` (Chiado), one with `false` (Sepolia).
/// @dev Mirrors what CRISP relies on in the real bridge:
///
/// - `requireToPassMessage` emits the real events (`UserRequestForAffirmation` on the Foreign side,
///   `UserRequestForSignature` on the Home side) with an opaque `encodedData`, plus a decoded `MockMessage`;
/// - Foreign -> Home is delivered by anyone calling `executeAffirmation(encodedData)` on the Home mock (validators on the
///   real bridge); Home -> Foreign by `getSignatures(encodedData)` on the Home mock (the AMB Helper) then
///   `executeSignatures(encodedData, signatures)` on the Foreign mock;
/// - execution sets `messageSender()` for the duration of the call, gives the call the message's gas, and does NOT revert
///   when the call fails: the message is consumed (not replayable) and `RelayedMessage` carries `status = false`; it does
///   revert, consuming nothing, when the transaction does not carry the message's gas limit (the real AMB's check).
contract MockAMB is IAMB {
  bool public immutable isHome;
  uint256 public immutable override maxGasPerTx;

  address public override messageSender;
  uint256 public nonce;
  mapping(bytes32 messageId => bool) public processed;

  error GasOutOfRange(uint256 gasLimit);
  error NotHome();
  error NotForeign();
  error AlreadyProcessed(bytes32 messageId);
  error InvalidSignatures();
  error NotEnoughGas(uint256 gasLimit);

  event UserRequestForAffirmation(bytes32 indexed messageId, bytes encodedData);
  event UserRequestForSignature(bytes32 indexed messageId, bytes encodedData);
  event MockMessage(address indexed from, address indexed to, bytes data, uint256 gas);
  event RelayedMessage(address indexed sender, address indexed executor, bytes32 indexed messageId, bool status);

  constructor(bool _isHome, uint256 _maxGasPerTx) {
    isHome = _isHome;
    maxGasPerTx = _maxGasPerTx;
  }

  function requireToPassMessage(address executor, bytes calldata data, uint256 gasLimit) external returns (bytes32 messageId) {
    if (gasLimit == 0 || gasLimit > maxGasPerTx) revert GasOutOfRange(gasLimit);

    messageId = bytes32(++nonce);
    bytes memory encodedData = abi.encode(messageId, msg.sender, executor, gasLimit, data);
    if (isHome) emit UserRequestForSignature(messageId, encodedData);
    else emit UserRequestForAffirmation(messageId, encodedData);
    emit MockMessage(msg.sender, executor, data, gasLimit);
  }

  /// @notice Foreign -> Home delivery. Anyone may call.
  function executeAffirmation(bytes calldata encodedData) external {
    if (!isHome) revert NotHome();
    _execute(encodedData);
  }

  /// @notice The AMB Helper's view: the "signatures" of a Home message, which {executeSignatures} accepts.
  function getSignatures(bytes calldata encodedData) external pure returns (bytes memory) {
    return abi.encode(keccak256(encodedData));
  }

  /// @notice Home -> Foreign delivery. Anyone may call.
  function executeSignatures(bytes calldata encodedData, bytes calldata signatures) external {
    if (isHome) revert NotForeign();
    if (keccak256(signatures) != keccak256(abi.encode(keccak256(encodedData)))) revert InvalidSignatures();
    _execute(encodedData);
  }

  function _execute(bytes calldata encodedData) internal {
    (bytes32 messageId, address sender, address executor, uint256 gasLimit, bytes memory data) = abi.decode(
      encodedData,
      (bytes32, address, address, uint256, bytes)
    );
    if (processed[messageId]) revert AlreadyProcessed(messageId);
    // As the real AMB: the call must be able to receive its whole gas limit, so `eth_estimateGas` finds a gas value at which
    // the receiver does not run out of gas (and the message is not consumed by a call that could not have succeeded).
    if ((gasleft() * 63) / 64 <= gasLimit) revert NotEnoughGas(gasLimit);
    processed[messageId] = true;

    messageSender = sender;
    (bool success, ) = executor.call{ gas: gasLimit }(data);
    messageSender = address(0);

    emit RelayedMessage(sender, executor, messageId, success);
  }
}
