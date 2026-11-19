// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.
pragma solidity >=0.8.27;

import { ERC20 } from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import { ERC20Permit } from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import { ERC20Votes } from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Votes.sol";
import { Nonces } from "@openzeppelin/contracts/utils/Nonces.sol";
import { Ownable } from "@openzeppelin/contracts/access/Ownable.sol";

/// @title CrispDemoToken
/// @notice The demo DAO's voting token (18 decimals), on the ERC-6372 timestamp clock, with a gasless faucet.
/// @dev A round weighs ballots by `getPastVotes(slot, snapshot)`, where the snapshot is the Sepolia request timestamp
/// minus one: voting power counts only if it was minted (and delegated) before the proposal was requested.
///
/// - The faucet key ({faucet}) mints {faucetAmount} to a recipient at most once per {faucetCooldown}, and self-delegates
///   the recipient if they have no delegate, because ERC20Votes only checkpoints votes of a delegating account. Plain
///   transfers do not auto-delegate: that keeps the ERC20Votes semantics standard.
/// - The owner mints the treasury (to the Safe) with {mintTreasury}. The Safe is a contract and does not delegate, so
///   treasury tokens carry no votes but count in `getPastTotalSupply` (the divisor and quorum denominators).
contract CrispDemoToken is ERC20, ERC20Permit, ERC20Votes, Ownable {
  /// @notice Tokens minted per faucet claim.
  uint256 public immutable faucetAmount;
  /// @notice Seconds a recipient waits between two claims.
  uint256 public immutable faucetCooldown;
  /// @notice The only account that may call {faucetMint}.
  address public faucet;
  /// @notice Timestamp of the last claim of each recipient; zero if never.
  mapping(address recipient => uint256) public lastFaucetMintAt;

  error NotFaucet(address caller);
  error FaucetCooldown(address recipient, uint256 availableAt);

  event FaucetSet(address indexed faucet);

  constructor(
    address _owner,
    uint256 _faucetAmount,
    uint256 _faucetCooldown
  ) ERC20("CRISP Demo COW", "dCOW") ERC20Permit("CRISP Demo COW") Ownable(_owner) {
    faucetAmount = _faucetAmount;
    faucetCooldown = _faucetCooldown;
  }

  /// @notice Mint {faucetAmount} to `to` and self-delegate it if it has no delegate. Faucet only; per-recipient cooldown.
  function faucetMint(address to) external {
    if (msg.sender != faucet) revert NotFaucet(msg.sender);
    uint256 last = lastFaucetMintAt[to];
    if (last != 0 && block.timestamp < last + faucetCooldown) revert FaucetCooldown(to, last + faucetCooldown);

    lastFaucetMintAt[to] = block.timestamp;
    _mint(to, faucetAmount);
    if (delegates(to) == address(0)) _delegate(to, to);
  }

  /// @notice Plain mint, with no delegation: for the Safe's treasury.
  function mintTreasury(address to, uint256 amount) external onlyOwner {
    _mint(to, amount);
  }

  function setFaucet(address _faucet) external onlyOwner {
    faucet = _faucet;
    emit FaucetSet(_faucet);
  }

  /// @notice ERC-6372: the clock is the block timestamp.
  function clock() public view override returns (uint48) {
    return uint48(block.timestamp);
  }

  /// @dev Declared pure per ERC-6372, so it cannot read `clock()`.
  function CLOCK_MODE() public pure override returns (string memory) {
    return "mode=timestamp";
  }

  function _update(address from, address to, uint256 value) internal override(ERC20, ERC20Votes) {
    super._update(from, to, value);
  }

  function nonces(address owner) public view override(ERC20Permit, Nonces) returns (uint256) {
    return super.nonces(owner);
  }
}
