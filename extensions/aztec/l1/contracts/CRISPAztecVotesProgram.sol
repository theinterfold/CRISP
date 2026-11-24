// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.
pragma solidity >=0.8.27;

import { IVotes } from "@openzeppelin/contracts/governance/utils/IVotes.sol";
import { IERC6372 } from "@openzeppelin/contracts/interfaces/IERC6372.sol";
import { Strings } from "@openzeppelin/contracts/utils/Strings.sol";
import { IOpenVmReceiptVerifier } from "@interfold/contracts/contracts/interfaces/IOpenVmReceiptVerifier.sol";
import { IDataAvailabilityVerifier } from "@interfold/contracts/contracts/interfaces/IDataAvailabilityVerifier.sol";
import { E3 } from "@interfold/contracts/contracts/interfaces/IE3.sol";
import { CRISPRemoteMessages } from "@crisp-e3/extension-core/contracts/CRISPRemoteMessages.sol";
import { CRISPAztecTransport } from "./CRISPAztecTransport.sol";
import { IAztecInbox, IAztecOutbox } from "./interfaces/IAztecMessageBridge.sol";

/// @title CRISPAztecVotesProgram
/// @notice Token-weighted CRISP E3 program whose ballots are cast on Aztec (`crisp_aztec_votes`).
/// @dev `customParams` are `CRISPProgram`'s; the weight of a slot is `getPastVotes(slot, snapshot) / divisor`. Weights are
/// bridged to Aztec per slot by the permissionless {enroll}: the program reads the token itself, so nobody can forge one.
contract CRISPAztecVotesProgram is CRISPAztecTransport {
  /// @dev `CRISPProgram.CreditMode.CUSTOM` and `CensusMode.ONCHAIN`: the only combination this program runs.
  uint256 internal constant CREDIT_MODE_CUSTOM = 1;
  uint256 internal constant CENSUS_MODE_ONCHAIN = 2;
  /// @dev First word of the ENROLL message; ROUND, KEY and ROOT are {CRISPRemoteMessages}'s kinds.
  uint256 internal constant KIND_ENROLL = 4;

  /// @notice What a round reads its voting power from.
  struct Votes {
    address token;
    uint48 snapshot;
    uint256 minVotingPower;
    uint256 divisor;
  }

  mapping(uint256 e3Id => Votes) internal votes;
  mapping(uint256 e3Id => mapping(address slot => bool)) public isEnrolled;

  error InvalidNumOptions();
  error UnsupportedCreditMode(uint256 creditMode);
  error UnsupportedCredits(uint256 credits);
  error UnsupportedCensusMode(uint256 censusMode);
  /// @notice The token has no code or does not answer `getPastVotes`.
  error CensusModeRequiresToken();
  /// @notice The token does not answer `getPastTotalSupply`.
  error CustomCreditsRequireVotesToken();
  error VotingPowerDivisorBelowMinimum(uint256 divisor, uint256 minimum);
  /// @notice The floor is below the divisor, so a slot at the floor would weigh zero.
  error MinVotingPowerBelowScale();
  error InputWindowClosed(uint256 e3Id, uint256 inputEnd);

  /// @notice A slot's weight was sent to Aztec. `leaf` is the Inbox leaf the L2 `enroll` consumes it with.
  event Enrolled(uint256 indexed e3Id, address indexed slot, uint256 weight, bytes32 leaf);

  /// @dev Parameters: see {CRISPAztecTransport}.
  constructor(
    address _initialOwner,
    IOpenVmReceiptVerifier _openVmVerifier,
    bytes32 _imageId,
    IDataAvailabilityVerifier _dataAvailabilityVerifier,
    uint256 _minVotingDuration,
    uint256 _remoteFinalityWindow,
    IAztecInbox _inbox,
    IAztecOutbox _outbox,
    uint256 _rollupVersion
  )
    CRISPAztecTransport(
      _initialOwner,
      _openVmVerifier,
      _imageId,
      _dataAvailabilityVerifier,
      _minVotingDuration,
      _remoteFinalityWindow,
      _inbox,
      _outbox,
      _rollupVersion
    )
  {}

  /// @notice Send the weight of each slot to Aztec; returns how many were sent.
  /// @dev Permissionless. Slots already enrolled or below the floor are skipped without reverting.
  function enroll(uint256 e3Id, address[] calldata slots) external returns (uint256 enrolled) {
    if (rounds[e3Id].paramsHash == bytes32(0)) revert E3NotAssignedToProgram(e3Id);
    uint256 inputEnd = interfold.getE3(e3Id).inputWindow[1];
    if (block.timestamp >= inputEnd) revert InputWindowClosed(e3Id, inputEnd);

    uint256 roundId = remoteRoundId(e3Id);
    for (uint256 i = 0; i < slots.length; i++) {
      address slot = slots[i];
      if (isEnrolled[e3Id][slot]) continue;
      uint256 weight = weightOf(e3Id, slot);
      if (weight == 0) continue;

      isEnrolled[e3Id][slot] = true;
      // ENROLL: `abi.encode(4, roundId, uint256(uint160(slot)), weight)`; the Noir contract and the SDK mirror it.
      (, bytes32 leaf) = _sendToInbox(e3Id, abi.encode(KIND_ENROLL, roundId, uint256(uint160(slot)), weight));
      emit Enrolled(e3Id, slot, weight, leaf);
      enrolled++;
    }
  }

  /// @notice The weight a slot carries: its voting power at the snapshot over the divisor, zero below the floor.
  function weightOf(uint256 e3Id, address slot) public view returns (uint256) {
    Votes storage v = votes[e3Id];
    uint256 raw = IVotes(v.token).getPastVotes(slot, v.snapshot);
    return raw < v.minVotingPower ? 0 : raw / v.divisor;
  }

  /// @notice Interfold's governance plugin reads no availability window: inputs live on Aztec.
  function availabilityFinalizationWindow() external pure returns (uint256) {
    return 0;
  }

  function votingPowerDivisorOf(uint256 e3Id) external view returns (uint256) {
    return votes[e3Id].divisor;
  }

  function snapshotOf(uint256 e3Id) external view returns (uint48) {
    return votes[e3Id].snapshot;
  }

  /// @notice Informational scope: `crisp-aztec-votes:<chainId>:<lowercase program address>:<e3Id>`.
  function scopeOf(uint256 e3Id) public view override returns (string memory) {
    return
      string.concat(
        "crisp-aztec-votes:",
        Strings.toString(block.chainid),
        ":",
        Strings.toHexString(address(this)),
        ":",
        Strings.toString(e3Id)
      );
  }

  /// @notice Decode `customParams` (`abi.encode(address token, uint256 minVotingPower, uint256 numOptions, uint8 creditMode,
  /// uint256 credits, uint256 censusMode, uint256 requestedDivisor)`), record the round and build the ROUND message.
  /// @dev Only CUSTOM credits (0) with ONCHAIN census are accepted. Snapshot and divisor follow `CRISPProgram._initCredits`.
  function _initRound(
    uint256 e3Id,
    E3 memory e3,
    uint256 plaintextModulus,
    bytes calldata customParams
  ) internal override returns (bytes memory message, uint256 numOptions, uint256 inputLimit) {
    Votes storage v = votes[e3Id];
    uint256 requestedDivisor;
    (v.token, v.minVotingPower, numOptions, requestedDivisor) = _decodeCustomParams(customParams);

    address token = v.token;
    if (token.code.length == 0) revert CensusModeRequiresToken();
    uint48 snapshot = _previousTimepoint(token);
    try IVotes(token).getPastVotes(address(0), snapshot) returns (uint256) {} catch {
      revert CensusModeRequiresToken();
    }

    uint256 divisor;
    try IVotes(token).getPastTotalSupply(snapshot) returns (uint256 supply) {
      uint256 minimum = supply / plaintextModulus + 1;
      divisor = requestedDivisor == 0 ? minimum : requestedDivisor;
      if (divisor < minimum) revert VotingPowerDivisorBelowMinimum(divisor, minimum);
    } catch {
      revert CustomCreditsRequireVotesToken();
    }
    if (v.minVotingPower < divisor) revert MinVotingPowerBelowScale();

    v.snapshot = snapshot;
    v.divisor = divisor;
    inputLimit = MAX_INPUTS_PER_ROUND;
    // ROUND: `abi.encode(1, roundId, numOptions, inputStart, inputEnd, inputLimit)`; the Noir contract and the SDK mirror it.
    message = abi.encode(CRISPRemoteMessages.KIND_ROUND, remoteRoundId(e3Id), numOptions, e3.inputWindow[0], e3.inputWindow[1], inputLimit);
  }

  /// @dev Decode `customParams` and refuse every mode but CUSTOM credits 0 with the ONCHAIN census.
  function _decodeCustomParams(
    bytes calldata customParams
  ) internal pure returns (address token, uint256 minVotingPower, uint256 numOptions, uint256 requestedDivisor) {
    uint256 creditMode;
    uint256 credits;
    uint256 censusMode;
    (token, minVotingPower, numOptions, creditMode, credits, censusMode, requestedDivisor) = abi.decode(
      customParams,
      (address, uint256, uint256, uint256, uint256, uint256, uint256)
    );
    if (numOptions < 2 || numOptions > MAX_VOTE_OPTIONS) revert InvalidNumOptions();
    if (creditMode != CREDIT_MODE_CUSTOM) revert UnsupportedCreditMode(creditMode);
    if (credits != 0) revert UnsupportedCredits(credits);
    if (censusMode != CENSUS_MODE_ONCHAIN) revert UnsupportedCensusMode(censusMode);
  }

  /// @dev The last finalized timepoint of a token in its ERC-6372 units; block numbers when it has no `clock()`.
  function _previousTimepoint(address token) internal view returns (uint48) {
    try IERC6372(token).clock() returns (uint48 current) {
      return current == 0 ? 0 : current - 1;
    } catch {
      return uint48(block.number - 1);
    }
  }
}
