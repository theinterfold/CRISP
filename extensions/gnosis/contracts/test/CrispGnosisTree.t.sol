// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.
pragma solidity >=0.8.27;

import { Vm } from "forge-std/Test.sol";
import { CrispGnosisVoting } from "../contracts/chiado/CrispGnosisVoting.sol";
import { VotingBase } from "./VotingBase.sol";

/// @notice The input tree equals `CRISPProgram`'s. The fixtures are the ones `packages/crisp-contracts/tests/input-tree-e2e.test.ts`
/// generated from REAL ballots published to `CRISPProgram` (real ciphertexts, real commitments, real slot parent chains), with the
/// `inputRoot` that contract computed; here the same inputs go through `CrispGnosisVoting.publishInput` (mock Honk verifier: no
/// Noir proof fixture exists) and `closeRound` must produce the same root. The Rust server rebuilds its tree from the same logs.
contract CrispGnosisTreeTest is VotingBase {
  address internal constant FIXTURE_SLOT = 0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266;

  function setUp() public {
    _deployVoting(0);
    // Funded before the round's snapshot (T0 + 50).
    vm.warp(T0 + 10);
    _fund(FIXTURE_SLOT, 1_000_000e18);
    vm.warp(T0 + 100);
  }

  function _replay(string memory file) internal returns (uint256 root, uint256 numInputs, string memory json) {
    json = vm.readFile(string.concat("./test/fixtures/", file));
    uint256 count;
    while (vm.keyExistsJson(json, string.concat(".inputs[", vm.toString(count), "]"))) count++;

    uint256 e3Id = _openAndStart();
    for (uint256 i = 0; i < count; i++) {
      string memory prefix = string.concat(".inputs[", vm.toString(i), "]");
      bytes memory encryptedVote = vm.parseJsonBytes(json, string.concat(prefix, ".encryptedVote"));
      bytes32 commitment = vm.parseJsonBytes32(json, string.concat(prefix, ".commitment"));
      address slot = vm.parseJsonAddress(json, string.concat(prefix, ".slot"));
      uint40 parent = uint40(vm.parseJsonUint(json, string.concat(prefix, ".parentIndexPlusOne")));
      assertEq(slot, FIXTURE_SLOT);
      _publish(e3Id, slot, commitment, keccak256(encryptedVote), parent);
    }

    vm.warp(INPUT_END);
    vm.recordLogs();
    voting.closeRound(ROUND_ID);
    (root, numInputs) = _closed(vm.getRecordedLogs());
  }

  function test_aSingleInputGivesCrispProgramsRoot() public {
    (uint256 root, uint256 numInputs, string memory json) = _replay("crisp-program-input-tree.json");
    assertEq(numInputs, 1);
    assertEq(bytes32(root), vm.parseJsonBytes32(json, ".inputRoot"));

    // The leaf CRISPProgram computed for it.
    bytes memory encryptedVote = vm.parseJsonBytes(json, ".inputs[0].encryptedVote");
    bytes32 commitment = vm.parseJsonBytes32(json, ".inputs[0].commitment");
    assertEq(voting.inputLeaf(keccak256(encryptedVote), commitment, FIXTURE_SLOT, 0), vm.parseJsonUint(json, ".contractLeaf"));
  }

  function test_aMaskThenARecoveryGivesCrispProgramsRoot() public {
    (uint256 root, uint256 numInputs, string memory json) = _replay("crisp-program-input-tree-append.json");
    assertEq(numInputs, 3);
    assertEq(bytes32(root), vm.parseJsonBytes32(json, ".inputRoot"));
  }

  function test_aReVoteGivesCrispProgramsRoot() public {
    (uint256 root, uint256 numInputs, string memory json) = _replay("crisp-program-input-tree-revote.json");
    assertEq(numInputs, 2);
    assertEq(bytes32(root), vm.parseJsonBytes32(json, ".inputRoot"));
  }
}
