// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.
pragma solidity >=0.8.27;

import { ICrispVoting } from "../interfaces/ICrispVoting.sol";

/// @notice An {ICrispVoting} whose rounds and results are set by the test, for the governance module.
contract MockCrispVoting is ICrispVoting {
  mapping(uint256 roundId => bytes32) public proposalHashOf;
  mapping(uint256 roundId => uint256) public divisorOf;
  mapping(uint256 roundId => Result) internal results;

  function setRound(uint256 roundId, bytes32 proposalHash, uint256 divisor) external {
    proposalHashOf[roundId] = proposalHash;
    divisorOf[roundId] = divisor;
  }

  function setResult(uint256 roundId, uint256[] calldata tally, uint64 resolvedAt) external {
    results[roundId] = Result({ resolved: true, resolvedAt: resolvedAt, tally: tally });
  }

  function resultOf(uint256 roundId) external view returns (Result memory) {
    return results[roundId];
  }

  function roundOf(uint256) external pure returns (Round memory round) {
    return round;
  }
}
