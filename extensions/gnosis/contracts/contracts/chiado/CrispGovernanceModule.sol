// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.
pragma solidity >=0.8.27;

import { Module } from "@gnosis-guild/zodiac-core/contracts/core/Module.sol";
import { Operation } from "@gnosis-guild/zodiac-core/contracts/core/Operation.sol";
import { ICrispVoting } from "../interfaces/ICrispVoting.sol";
import { IMultiSend } from "../interfaces/IMultiSend.sol";

/// @title CrispGovernanceModule
/// @notice Zodiac module that turns a decrypted CRISP tally into a Safe transaction batch, queued in a Zodiac Delay.
/// @dev Topology: `Safe (avatar) <- Delay (module of the Safe; avatar = target = Safe, owner = Safe) <- this module (module of
/// Delay; avatar = Safe, target = Delay, owner = Safe)`. {executeProposal} does not execute: it queues the batch as ONE
/// DelegateCall to `MultiSendCallOnly` in the Delay, whose cooldown gives the Safe owners time to veto (`setTxNonce`) before
/// anyone runs it with `executeNextTx`. One MultiSend delegatecall is one Delay entry, so any inner failure reverts the
/// whole batch.
///
/// The batch is bound by `proposalHash = keccak256(packed batch)`, which the proposer fixed in the E3 request on Sepolia
/// and which `CrispGnosisVoting` stored: nobody can substitute another batch. `quorum` and `approvalBps` are read at
/// execution time and only the Safe can change them. Everything fails closed: without a RESULT nothing executes.
///
/// Deploy the mastercopy with {constructor} (which initialises it, so nobody can) and proxy it through the Zodiac
/// `ModuleProxyFactory` with `setUp(abi.encode(owner, avatar, target, voting, multiSend, quorum, approvalBps, expiration))`.
contract CrispGovernanceModule is Module {
  uint256 internal constant BPS = 10_000;

  /// @notice The Chiado voting contract the results and proposal hashes are read from.
  ICrispVoting public voting;
  /// @notice `MultiSendCallOnly`: the batch is delegatecalled into it by the Safe.
  address public multiSend;
  /// @notice Minimum participation in token wei (18 decimals): `(for + against + abstain) * divisor >= quorum`.
  uint256 public quorum;
  /// @notice A proposal passes iff `for * 10_000 > approvalBps * (for + against)` (strict: a tie fails). 1..9_999: 10_000 could never pass.
  uint16 public approvalBps;
  /// @notice Seconds after the result arrived during which {executeProposal} is allowed; 0 = no limit.
  uint64 public expiration;
  /// @notice Whether the proposal of a round was queued.
  mapping(uint256 roundId => bool) public executed;

  error InvalidParams();
  error NoResult();
  error HashMismatch();
  error AlreadyExecuted();
  error QuorumNotMet();
  error NotApproved();
  error ResultExpired();
  error ExecutionFailed();

  event CrispGovernanceModuleSetUp(address indexed initiator, address indexed owner, address indexed avatar, address target);
  event ProposalQueued(uint256 indexed roundId, bytes32 proposalHash, uint256 forVotes, uint256 againstVotes, uint256 abstainVotes);
  event VotingSet(address indexed voting);
  event MultiSendSet(address indexed multiSend);
  event QuorumSet(uint256 quorum);
  event ApprovalBpsSet(uint16 approvalBps);
  event ExpirationSet(uint64 expiration);

  /// @param initializeParams See {setUp}. Initialises the mastercopy itself.
  constructor(bytes memory initializeParams) {
    setUp(initializeParams);
  }

  /// @param initializeParams `abi.encode(address owner, address avatar, address target, address voting, address multiSend,
  /// uint256 quorum, uint16 approvalBps, uint64 expiration)`.
  function setUp(bytes memory initializeParams) public override initializer {
    (
      address _owner,
      address _avatar,
      address _target,
      address _voting,
      address _multiSend,
      uint256 _quorum,
      uint16 _approvalBps,
      uint64 _expiration
    ) = abi.decode(initializeParams, (address, address, address, address, address, uint256, uint16, uint64));
    if (_avatar == address(0) || _target == address(0) || _voting == address(0) || _multiSend == address(0)) revert InvalidParams();
    if (_approvalBps == 0 || _approvalBps >= BPS) revert InvalidParams();

    _transferOwnership(_owner);
    avatar = _avatar;
    target = _target;
    voting = ICrispVoting(_voting);
    multiSend = _multiSend;
    quorum = _quorum;
    approvalBps = _approvalBps;
    expiration = _expiration;

    emit CrispGovernanceModuleSetUp(msg.sender, _owner, _avatar, _target);
    emit AvatarSet(address(0), _avatar);
    emit TargetSet(address(0), _target);
  }

  /// @notice Check the result of `roundId` and queue its batch in the Delay. Permissionless, once per round.
  /// @param roundId The remote round id (`uint96(e3Id)`).
  /// @param transactions The packed MultiSend batch; its hash must be the round's `proposalHash`.
  function executeProposal(uint256 roundId, bytes calldata transactions) external {
    if (executed[roundId]) revert AlreadyExecuted();

    ICrispVoting.Result memory result = voting.resultOf(roundId);
    if (!result.resolved) revert NoResult();
    bytes32 proposalHash = voting.proposalHashOf(roundId);
    if (keccak256(transactions) != proposalHash) revert HashMismatch();
    if (expiration != 0 && block.timestamp > uint256(result.resolvedAt) + expiration) revert ResultExpired();

    uint256 forVotes = result.tally[0];
    uint256 againstVotes = result.tally[1];
    uint256 abstainVotes = result.tally[2];
    if ((forVotes + againstVotes + abstainVotes) * voting.divisorOf(roundId) < quorum) revert QuorumNotMet();
    if (forVotes * BPS <= uint256(approvalBps) * (forVotes + againstVotes)) revert NotApproved();

    executed[roundId] = true;
    bool success = exec(multiSend, 0, abi.encodeWithSelector(IMultiSend.multiSend.selector, transactions), Operation.DelegateCall);
    if (!success) revert ExecutionFailed();

    emit ProposalQueued(roundId, proposalHash, forVotes, againstVotes, abstainVotes);
  }

  function setVoting(address _voting) external onlyOwner {
    if (_voting == address(0)) revert InvalidParams();
    voting = ICrispVoting(_voting);
    emit VotingSet(_voting);
  }

  function setMultiSend(address _multiSend) external onlyOwner {
    if (_multiSend == address(0)) revert InvalidParams();
    multiSend = _multiSend;
    emit MultiSendSet(_multiSend);
  }

  function setQuorum(uint256 _quorum) external onlyOwner {
    quorum = _quorum;
    emit QuorumSet(_quorum);
  }

  function setApprovalBps(uint16 _approvalBps) external onlyOwner {
    if (_approvalBps == 0 || _approvalBps >= BPS) revert InvalidParams();
    approvalBps = _approvalBps;
    emit ApprovalBpsSet(_approvalBps);
  }

  function setExpiration(uint64 _expiration) external onlyOwner {
    expiration = _expiration;
    emit ExpirationSet(_expiration);
  }
}
