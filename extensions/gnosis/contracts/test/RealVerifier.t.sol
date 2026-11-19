// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.
pragma solidity >=0.8.27;

import { IHonkVerifier } from "@crisp-e3/contracts/contracts/interfaces/IHonkVerifier.sol";
import { IVotesToken } from "@crisp-e3/contracts/contracts/interfaces/IVotesToken.sol";
import { HonkVerifier } from "@crisp-e3/contracts/contracts/verifiers/CRISPOnchainVerifier.sol";
import { CrispGnosisVoting } from "../contracts/chiado/CrispGnosisVoting.sol";
import { IAMB } from "../contracts/interfaces/IAMB.sol";
import { VotingBase } from "./VotingBase.sol";

/// @notice The voting contract against the REAL `CRISPOnchainVerifier` (linked libraries). The repository carries no valid Noir
/// proof fixture, so this shows what can be shown without one: the verifier deploys within the code-size limit, takes the voting
/// contract's nine public inputs, and refuses a proof that is not one. A valid proof is exercised end to end by the e2e.
contract RealVerifierTest is VotingBase {
  HonkVerifier internal verifier;

  function setUp() public {
    _deployVoting(0);
    verifier = new HonkVerifier();
    voting = new CrispGnosisVoting(
      IAMB(address(home)),
      interfold,
      program,
      IVotesToken(address(token)),
      IHonkVerifier(address(verifier)),
      signer,
      0
    );
  }

  function test_theVerifierFitsTheContractSizeLimit() public view {
    assertLe(address(verifier).code.length, 24_576);
  }

  function test_aProofThatIsNotOneIsRefused() public {
    uint256 e3Id = _openAndStart();
    bytes memory garbage = new bytes(14_592);
    bytes memory data = abi.encode(
      garbage,
      alice,
      bytes32(uint256(1)),
      bytes32(uint256(2)),
      uint40(0),
      uint64(block.timestamp + 1 hours),
      _attestation(e3Id, voting.inputId(e3Id, bytes32(uint256(2)), bytes32(uint256(1)), alice, 0), uint64(block.timestamp + 1 hours), signerKey)
    );
    vm.expectRevert();
    voting.publishInput(e3Id, data);

    vm.expectRevert();
    voting.validateInputProof(e3Id, garbage, alice, bytes32(uint256(1)), bytes32(uint256(2)), 0);
    vm.expectRevert();
    voting.validateInputProof(e3Id, "", alice, bytes32(uint256(1)), bytes32(uint256(2)), 0);
    assertEq(voting.roundOf(ROUND_ID).numInputs, 0);
  }
}
