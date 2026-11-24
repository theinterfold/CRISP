// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.
pragma solidity >=0.8.27;

import { Strings } from "@openzeppelin/contracts/utils/Strings.sol";
import { IOpenVmReceiptVerifier } from "@interfold/contracts/contracts/interfaces/IOpenVmReceiptVerifier.sol";
import { IDataAvailabilityVerifier } from "@interfold/contracts/contracts/interfaces/IDataAvailabilityVerifier.sol";
import { CRISPAztecTransport } from "./CRISPAztecTransport.sol";
import { CRISPRemoteMessages } from "@crisp-e3/extension-core/contracts/CRISPRemoteMessages.sol";
import { E3 } from "@interfold/contracts/contracts/interfaces/IE3.sol";
import { IAztecInbox, IAztecOutbox } from "./interfaces/IAztecMessageBridge.sol";

/// @title CRISPAztecProgram
/// @notice CRISP E3 program whose ballots are cast on Aztec (see `extensions/aztec/contracts`).
/// @dev The ZKPassport round rules; the Aztec bridge is {CRISPAztecTransport}, round logic {CRISPRemoteProgram}.
contract CRISPAztecProgram is CRISPAztecTransport {
  /// @notice Largest accepted `minAge`: the ZKPassport `Query::age_min` the L2 contract applies asserts `min < 100`.
  uint256 public constant MAX_MIN_AGE = 99;
  /// @notice The most countries a nationality rule lists: ZKPassport commits a list into 600 bytes (200 alpha-3 codes).
  uint256 public constant MAX_COUNTRIES = 200;

  /// @notice The decoded `customParams`.
  struct CustomParams {
    uint256 numOptions;
    uint256 credits;
    uint256 minAge;
    bool allowMockDocuments;
    uint8 nationalityMode;
    string[] countries;
    uint256 nationalityCommitment;
  }

  error InvalidNumOptions();
  error InvalidMinAge(uint256 minAge);
  error InvalidNationalityMode(uint256 mode);
  /// @notice A country list that is empty or too long for the mode, or holds an entry that is not three letters `A-Z`.
  error InvalidCountries();
  /// @notice Zero or not a field element with a nationality rule, or non-zero without one.
  error InvalidNationalityCommitment(uint256 commitment);
  error CreditsExceedPlaintextModulus(uint256 credits, uint256 plaintextModulus);

  /// @notice Who may join a round: the decoded rules, for apps that recompute the nationality commitment and build the
  /// ZKPassport request (`nationalityCommitment` is zero iff `nationalityMode` is 0).
  event RoundRules(
    uint256 indexed e3Id,
    uint256 minAge,
    bool allowMockDocuments,
    uint8 nationalityMode,
    string[] countries,
    uint256 nationalityCommitment
  );

  /// @param _inbox Aztec Inbox of the target rollup.
  /// @param _outbox Aztec Outbox of the target rollup.
  /// @param _rollupVersion Rollup version; refused unless both bridge contracts report it.
  /// @dev Remaining parameters: see {CRISPRemoteProgram}.
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
  ) CRISPAztecTransport(
    _initialOwner,
    _openVmVerifier,
    _imageId,
    _dataAvailabilityVerifier,
    _minVotingDuration,
    _remoteFinalityWindow,
    _inbox,
    _outbox,
    _rollupVersion
  ) {}

  /// @notice Scope string a ZKPassport proof is bound to: `crisp-aztec:<chainId>:<lowercase program address>:<e3Id>`.
  function scopeOf(uint256 e3Id) public view override returns (string memory) {
    return
      string.concat("crisp-aztec:", Strings.toString(block.chainid), ":", Strings.toHexString(address(this)), ":", Strings.toString(e3Id));
  }

  /// @notice Decode and validate `customParams` and build the 12-word ZKPassport ROUND message.
  /// @dev The input limit follows `CRISPProgram._initCredits` for constant credits (`(t - 1) / credits` keeps every option
  /// total below the plaintext modulus `t`), capped at {MAX_INPUTS_PER_ROUND}.
  function _initRound(
    uint256 e3Id,
    E3 memory e3,
    uint256 plaintextModulus,
    bytes calldata customParams
  ) internal override returns (bytes memory message, uint256 numOptions, uint256 inputLimit) {
    CustomParams memory params = _decodeCustomParams(customParams);
    CRISPRemoteMessages.RoundConfig memory config = _roundConfig(e3Id, e3, params, plaintextModulus);

    emit RoundRules(
      e3Id,
      params.minAge,
      params.allowMockDocuments,
      params.nationalityMode,
      params.countries,
      params.nationalityCommitment
    );

    return (CRISPRemoteMessages.round(config), config.numOptions, config.inputLimit);
  }

  /// @notice Decode and validate `customParams`.
  /// @dev `abi.encode(uint256 numOptions, uint256 credits, uint256 minAge, bool allowMockDocuments, uint8 nationalityMode,
  /// string[] countries, uint256 nationalityCommitment)`.
  ///
  /// - mode 0: no list and no commitment; mode 1 or 2: 1..{MAX_COUNTRIES} alpha-3 codes, three letters `A-Z` each.
  /// - with a nationality rule the L2 checks ZKPassport's commitment of the list, which L1 cannot recompute, so it only
  ///   checks that one is given (a wrong one makes the round unregistrable).
  function _decodeCustomParams(bytes calldata customParams) internal pure returns (CustomParams memory params) {
    (
      params.numOptions,
      params.credits,
      params.minAge,
      params.allowMockDocuments,
      params.nationalityMode,
      params.countries,
      params.nationalityCommitment
    ) = abi.decode(customParams, (uint256, uint256, uint256, bool, uint8, string[], uint256));

    // The circuit asserts `num_options <= MAX_OPTIONS`; a larger round would accept no ballot at all.
    if (params.numOptions < 2 || params.numOptions > MAX_VOTE_OPTIONS) revert InvalidNumOptions();
    if (params.minAge > MAX_MIN_AGE) revert InvalidMinAge(params.minAge);

    uint256 mode = params.nationalityMode;
    if (mode > 2) revert InvalidNationalityMode(mode);
    uint256 count = params.countries.length;
    if (mode == 0 ? count != 0 : (count == 0 || count > MAX_COUNTRIES)) revert InvalidCountries();
    for (uint256 i = 0; i < count; i++) {
      bytes memory code = bytes(params.countries[i]);
      if (code.length != 3) revert InvalidCountries();
      for (uint256 j = 0; j < 3; j++) {
        if (code[j] < "A" || code[j] > "Z") revert InvalidCountries();
      }
    }

    uint256 commitment = params.nationalityCommitment;
    if (mode != 0 ? (commitment == 0 || commitment >= FIELD_MODULUS) : commitment != 0) revert InvalidNationalityCommitment(commitment);
  }

  /// @notice Build the ROUND config from validated parameters.
  function _roundConfig(
    uint256 e3Id,
    E3 memory e3,
    CustomParams memory params,
    uint256 plaintextModulus
  ) internal view returns (CRISPRemoteMessages.RoundConfig memory config) {
    uint256 credits = params.credits;
    // One ballot of `t` credits or more wraps an option total on its own.
    if (credits != 0 && credits >= plaintextModulus) revert CreditsExceedPlaintextModulus(credits, plaintextModulus);

    uint256 limit = credits == 0 ? MAX_INPUTS_PER_ROUND : (plaintextModulus - 1) / credits;

    config = CRISPRemoteMessages.RoundConfig({
      roundId: remoteRoundId(e3Id),
      numOptions: params.numOptions,
      credits: credits,
      inputStart: e3.inputWindow[0],
      inputEnd: e3.inputWindow[1],
      inputLimit: limit < MAX_INPUTS_PER_ROUND ? limit : MAX_INPUTS_PER_ROUND,
      scopeHash: scopeHashOf(e3Id),
      minAge: params.minAge,
      allowMockDocuments: params.allowMockDocuments,
      nationalityMode: params.nationalityMode,
      nationalityCommitment: params.nationalityCommitment
    });
  }
}
