// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

pragma solidity ^0.8.27;

/// The fee-token surface of `Interfold` that `e3_request::approve_e3_fee` reads and writes: the
/// quote, `feeToken()`, and the token's allowance. It is its own fee token.
///
/// The `e3_request` tests hold its creation code from
/// `solc --optimize --bin mock_fee_interfold.sol`.
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

  uint256 public fee;
  mapping(address => mapping(address => uint256)) public allowance;

  constructor(uint256 initialFee) {
    fee = initialFee;
  }

  function setFee(uint256 newFee) external {
    fee = newFee;
  }

  function feeToken() external view returns (address) {
    return address(this);
  }

  function getE3Quote(E3RequestParams calldata) external view returns (uint256) {
    return fee;
  }

  function approve(address spender, uint256 amount) external returns (bool) {
    allowance[msg.sender][spender] = amount;
    return true;
  }
}
