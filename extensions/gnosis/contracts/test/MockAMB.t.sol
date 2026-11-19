// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.
pragma solidity >=0.8.27;

import { Test, Vm } from "forge-std/Test.sol";
import { IAMB } from "../contracts/interfaces/IAMB.sol";
import { MockAMB } from "../contracts/test-mocks/MockAMB.sol";

contract Receiver {
  address public lastSender;
  uint256 public calls;
  bool public fail;
  IAMB internal immutable amb;

  constructor(IAMB _amb) {
    amb = _amb;
  }

  function setFail(bool value) external {
    fail = value;
  }

  function receiveMessage(bytes calldata) external {
    require(!fail, "receiver failed");
    lastSender = amb.messageSender();
    calls++;
  }
}

/// @notice The MockAMB behaves like the pieces of the real bridge CRISP relies on.
contract MockAMBTest is Test {
  MockAMB internal home;
  MockAMB internal foreign;
  Receiver internal receiver;
  address internal sender = makeAddr("sender");

  function setUp() public {
    home = new MockAMB(true, 2_000_000);
    foreign = new MockAMB(false, 4_000_000);
    receiver = new Receiver(IAMB(address(home)));
  }

  function _message(bytes32 id, uint256 gasLimit) internal view returns (bytes memory) {
    return abi.encode(id, sender, address(receiver), gasLimit, abi.encodeCall(Receiver.receiveMessage, (hex"01")));
  }

  function test_executionSetsTheMessageSenderOnlyDuringTheCall() public {
    home.executeAffirmation(_message(bytes32(uint256(1)), 500_000));
    assertEq(receiver.lastSender(), sender);
    assertEq(home.messageSender(), address(0));
  }

  function test_aMessageIsConsumedOnceEvenWhenTheReceiverFails() public {
    receiver.setFail(true);
    bytes memory encoded = _message(bytes32(uint256(1)), 500_000);
    vm.recordLogs();
    home.executeAffirmation(encoded);
    Vm.Log[] memory logs = vm.getRecordedLogs();
    assertFalse(abi.decode(logs[logs.length - 1].data, (bool)));

    receiver.setFail(false);
    vm.expectRevert(abi.encodeWithSelector(MockAMB.AlreadyProcessed.selector, bytes32(uint256(1))));
    home.executeAffirmation(encoded);
    assertEq(receiver.calls(), 0);
  }

  /// @dev The real AMB refuses to start a call it cannot give its whole gas limit; so does the mock, and the message stays
  /// deliverable. This is what lets `eth_estimateGas` size a relay transaction.
  function test_aRelayWithTooLittleGasRevertsAndConsumesNothing() public {
    bytes memory encoded = _message(bytes32(uint256(1)), 1_000_000);
    vm.expectRevert(abi.encodeWithSelector(MockAMB.NotEnoughGas.selector, 1_000_000));
    home.executeAffirmation{ gas: 500_000 }(encoded);
    assertFalse(home.processed(bytes32(uint256(1))));

    home.executeAffirmation{ gas: 1_200_000 }(encoded);
    assertEq(receiver.calls(), 1);
  }

  function test_theDirectionsAreEnforced() public {
    vm.expectRevert(MockAMB.NotHome.selector);
    foreign.executeAffirmation(_message(bytes32(uint256(1)), 500_000));

    bytes memory encoded = _message(bytes32(uint256(2)), 500_000);
    bytes memory signatures = home.getSignatures(encoded);
    vm.expectRevert(MockAMB.NotForeign.selector);
    home.executeSignatures(encoded, signatures);

    vm.expectRevert(MockAMB.InvalidSignatures.selector);
    foreign.executeSignatures(encoded, abi.encode(keccak256("other")));
  }

  function test_requestsEmitTheRealEventsAndRespectMaxGas() public {
    vm.recordLogs();
    vm.prank(sender);
    bytes32 id = foreign.requireToPassMessage(address(receiver), hex"1234", 100);
    Vm.Log[] memory logs = vm.getRecordedLogs();
    assertEq(logs[0].topics[0], MockAMB.UserRequestForAffirmation.selector);
    assertEq(logs[0].topics[1], id);

    vm.recordLogs();
    vm.prank(sender);
    home.requireToPassMessage(address(receiver), hex"1234", 100);
    assertEq(vm.getRecordedLogs()[0].topics[0], MockAMB.UserRequestForSignature.selector);

    vm.expectRevert(abi.encodeWithSelector(MockAMB.GasOutOfRange.selector, 2_000_001));
    home.requireToPassMessage(address(receiver), hex"1234", 2_000_001);
    vm.expectRevert(abi.encodeWithSelector(MockAMB.GasOutOfRange.selector, 0));
    home.requireToPassMessage(address(receiver), hex"1234", 0);
  }
}
