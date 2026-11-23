// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.
pragma solidity >=0.8.27;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { ERC20Votes } from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import { EIP712 } from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";

/// @notice ERC20Votes with the default block-number clock.
contract MockVotesToken is ERC20Votes {
  constructor() ERC20("Votes", "VOTE") EIP712("Votes", "1") {}

  function mint(address to, uint256 amount) external {
    _mint(to, amount);
  }
}

/// @notice ERC20Votes on a timestamp ERC-6372 clock.
contract MockTimestampVotesToken is MockVotesToken {
  function clock() public view override returns (uint48) {
    return uint48(block.timestamp);
  }

  function CLOCK_MODE() public pure override returns (string memory) {
    return "mode=timestamp";
  }
}
