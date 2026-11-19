// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.
pragma solidity >=0.8.27;

import { IInterfold } from "@interfold/contracts/contracts/interfaces/IInterfold.sol";
import { IE3Program } from "@interfold/contracts/contracts/interfaces/IE3Program.sol";
import { MockDataAvailabilityVerifier } from "@interfold/contracts/contracts/test/MockDataAvailabilityVerifier.sol";
import { MockOpenVmReceiptVerifier } from "@crisp-e3/contracts/contracts/test/MockOpenVmReceiptVerifier.sol";
import { CRISPRemoteMessages } from "@crisp-e3/extension-core/contracts/CRISPRemoteMessages.sol";
import { CRISPGnosisProgram } from "../contracts/l1/CRISPGnosisProgram.sol";
import { CRISPGnosisMessages } from "../contracts/lib/CRISPGnosisMessages.sol";
import { IAMB } from "../contracts/interfaces/IAMB.sol";
import { IGnosisReceiver } from "../contracts/interfaces/IGnosisReceiver.sol";
import { MockAMB } from "../contracts/test-mocks/MockAMB.sol";
import { MockInterfold } from "../contracts/test-mocks/MockInterfold.sol";
import { VotingBase } from "./VotingBase.sol";

/// @notice Measures the gas the AMB limits in `CRISPGnosisMessages` are derived from, and fails if a limit is below twice what
/// was measured. Run `forge test --match-contract GasMeasurement -vv` to print the numbers.
///
/// The Noir proof is checked by `CRISPOnchainVerifier`, which no fixture here can drive (the repository carries no real proof),
/// so `publishInput` is measured with the mock verifier and the verifier's own cost is added from the design's research figure
/// (`HONK_VERIFY_GAS`, ~3.03 M). That sum is an estimate, not a measurement.
contract GasMeasurementTest is VotingBase {
  uint256 internal constant HONK_VERIFY_GAS = 3_030_000;
  uint256 internal constant PUBLISH_INPUT_TARGET = 3_600_000;

  function setUp() public {
    _deployVoting(0);
  }

  function _gasOf(address target, bytes memory data) internal returns (uint256 used) {
    uint256 before_ = gasleft();
    (bool ok, ) = target.call(data);
    used = before_ - gasleft();
    assertTrue(ok);
  }

  /// @dev Measured as the AMB would call it: from the Home AMB, as the program.
  function _receive(bytes memory message) internal returns (uint256 used) {
    vm.mockCall(address(home), abi.encodeWithSelector(IAMB.messageSender.selector), abi.encode(program));
    vm.prank(address(home));
    used = _gasOf(address(voting), abi.encodeCall(IGnosisReceiver.receiveMessage, (message)));
    vm.clearMockedCalls();
  }

  function test_measureTheHomeReceivers() public {
    // Many supply checkpoints make `getPastTotalSupply` search deeper, as the faucet will.
    for (uint256 i = 0; i < 200; i++) {
      vm.warp(block.timestamp + 1);
      vm.prank(owner);
      token.mintTreasury(address(uint160(0x1000 + i)), 1e18);
    }
    vm.warp(block.timestamp + 100);

    CRISPGnosisMessages.RoundMessage memory m = _roundMessage(ROUND_ID);
    m.snapshot = block.timestamp - 50;
    // The longest metadata pointer the program accepts.
    m.metadataCid = string(new bytes(128));
    uint256 roundGas = _receive(CRISPGnosisMessages.round(m));
    uint256 keyGas = _receive(CRISPRemoteMessages.committeeKey(ROUND_ID, COMMITTEE_KEY));

    uint256[] memory tally = new uint256[](3);
    tally[0] = 17_000_000;
    tally[1] = 17_000_000;
    tally[2] = 17_000_000;
    uint256 resultGas = _receive(CRISPGnosisMessages.result(ROUND_ID, tally));

    emit log_named_uint("receiveMessage(ROUND) gas, 128-byte CID, 200 supply checkpoints", roundGas);
    emit log_named_uint("receiveMessage(KEY) gas", keyGas);
    emit log_named_uint("receiveMessage(RESULT) gas", resultGas);

    assertGe(CRISPGnosisMessages.ROUND_GAS, 2 * roundGas, "ROUND_GAS below 2x measured");
    assertGe(CRISPGnosisMessages.KEY_GAS, 2 * keyGas, "KEY_GAS below 2x measured");
    assertGe(CRISPGnosisMessages.RESULT_GAS, 2 * resultGas, "RESULT_GAS below 2x measured");
  }

  /// @dev The leaf at index `2^k - 1` hashes `k` levels, the most a tree of that size pays; the input limit (65,536) caps it
  /// at 16 levels, so the worst case is extrapolated from the per-level cost (inserting 65,536 leaves here is too slow).
  function test_measurePublishInputAndCloseRound() public {
    uint256 e3Id = _openAndStart();

    uint256 first;
    uint256 atNine;
    uint256 atEight;
    uint256 n;
    for (uint256 k = 0; k <= 9; k++) {
      uint256 target = (1 << k) - 1;
      while (n < target) {
        _publish(e3Id, n % 2 == 0 ? alice : bob, n);
        n++;
      }
      bytes32 commitment = keccak256(abi.encode("commitment", n));
      bytes memory data = _data(e3Id, n % 2 == 0 ? alice : bob, commitment, keccak256(abi.encode("vote", n)), 0, uint64(block.timestamp + 1 hours), signerKey);
      uint256 used = _gasOf(address(voting), abi.encodeCall(voting.publishInput, (e3Id, data)));
      n++;
      emit log_named_uint(string.concat("publishInput (mock verifier) at leaf index ", vm.toString(target)), used);
      if (k == 0) first = used;
      if (k == 8) atEight = used;
      if (k == 9) atNine = used;
    }

    uint256 perLevel = atNine - atEight;
    uint256 worst = atNine + 7 * perLevel;
    emit log_named_uint("per extra tree level", perLevel);
    emit log_named_uint("publishInput worst case at 65,536 inputs (mock verifier, extrapolated)", worst);
    emit log_named_uint("publishInput worst case + real Honk verify (estimate)", worst + HONK_VERIFY_GAS);
    // The design target holds for demo-sized rounds (256 inputs); the tree level cost adds ~55k per doubling beyond them.
    assertLe(atEight + HONK_VERIFY_GAS, PUBLISH_INPUT_TARGET, "publishInput above 3.6M at 256 inputs");
    assertLe(first, worst);

    // A re-vote with a parent runs the same code plus one storage read.
    bytes memory revote = _data(e3Id, alice, keccak256("rv"), keccak256("rvh"), 1, uint64(block.timestamp + 1 hours), signerKey);
    emit log_named_uint("publishInput re-vote (mock verifier)", _gasOf(address(voting), abi.encodeCall(voting.publishInput, (e3Id, revote))));

    vm.warp(INPUT_END);
    uint256 closeGas = _gasOf(address(voting), abi.encodeCall(voting.closeRound, (ROUND_ID)));
    emit log_named_uint("closeRound gas (root of 513 leaves + AMB request)", closeGas);
  }

  /// @dev `receiveMessage(ROOT)` on the program, measured with `MockInterfold` (the real `getE3Stage` is one external call
  /// more of the same kind; the 2x margin covers it).
  function test_measureTheProgramRootReceiver() public {
    MockInterfold interfold_ = new MockInterfold();
    interfold_.setComputeWindow(7 days);
    MockAMB foreign = new MockAMB(false, 4_000_000);
    MockOpenVmReceiptVerifier openVm = new MockOpenVmReceiptVerifier();
    CRISPGnosisProgram program_ = new CRISPGnosisProgram(
      owner,
      openVm,
      openVm.imageId(),
      new MockDataAvailabilityVerifier(),
      0,
      0,
      IAMB(address(foreign)),
      0
    );
    interfold_.registerE3Program(IE3Program(address(program_)));
    vm.startPrank(owner);
    program_.bindInterfold(IInterfold(address(interfold_)));
    program_.setRemote(address(voting));
    program_.setProposer(requester, true);
    vm.stopPrank();

    vm.prank(requester);
    uint256 e3Id = interfold_.request(
      address(program_),
      [block.timestamp + 10, block.timestamp + 3700],
      abi.encode(uint8(0), bytes32(0), uint256(0), PROPOSAL_HASH, CID)
    );
    interfold_.setStage(e3Id, IInterfold.E3Stage.KeyPublished);

    vm.mockCall(address(foreign), abi.encodeWithSelector(IAMB.messageSender.selector), abi.encode(address(voting)));
    vm.prank(address(foreign));
    uint256 used = _gasOf(address(program_), abi.encodeCall(IGnosisReceiver.receiveMessage, (CRISPRemoteMessages.inputRoot(uint256(uint96(e3Id)), 123_456, 1_000))));
    emit log_named_uint("receiveMessage(ROOT) gas on the program", used);
    assertGe(CRISPGnosisMessages.ROOT_GAS, 2 * used, "ROOT_GAS below 2x measured");
  }
}
