// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

pragma solidity ^0.8.27;

/// The allowance side of an ERC-20 fee token. It can refuse approvals the way a token that
/// returns `false` from `approve` does: without a revert, and without an allowance.
contract MockFeeToken {
  mapping(address => mapping(address => uint256)) public allowance;
  bool public refusesApprovals;

  function setRefusesApprovals(bool refuses) external {
    refusesApprovals = refuses;
  }

  function approve(address spender, uint256 amount) external returns (bool) {
    if (refusesApprovals) return false;
    allowance[msg.sender][spender] = amount;
    return true;
  }
}

/// The fee-token surface of `Interfold` that `e3_request::approve_e3_fee` reads and writes: the
/// quote and `feeToken()`. The fee token is a separate contract, so an approval sent anywhere
/// else is not seen. A quote for any committee size or input window but the expected one reverts.
///
/// The `e3_request` tests hold its creation code, which includes the token's, from
/// `solc --optimize --bin mock_fee_interfold.sol`: the `MockFeeInterfold` output.
contract MockFeeInterfold {
  struct E3RequestParams {
    uint8 committeeSize;
    uint256[2] inputWindow;
    address e3Program;
    uint8 paramSet;
    bytes computeProviderParams;
    bytes customParams;
    address expectedFeeToken;
    bytes32 expectedCryptoConfigId;
    uint256 maxFee;
  }

  MockFeeToken public feeToken;
  uint256 public fee;
  uint8 public expectedCommitteeSize;
  uint256[2] public expectedInputWindow;

  constructor(uint256 initialFee) {
    feeToken = new MockFeeToken();
    fee = initialFee;
  }

  function expectQuote(uint8 committeeSize, uint256[2] calldata inputWindow) external {
    expectedCommitteeSize = committeeSize;
    expectedInputWindow = inputWindow;
  }

  function setFee(uint256 newFee) external {
    fee = newFee;
  }

  function getE3Quote(E3RequestParams calldata params) external view returns (uint256) {
    require(
      params.committeeSize == expectedCommitteeSize &&
        params.inputWindow[0] == expectedInputWindow[0] &&
        params.inputWindow[1] == expectedInputWindow[1],
      "unexpected quote arguments"
    );
    return fee;
  }
}
