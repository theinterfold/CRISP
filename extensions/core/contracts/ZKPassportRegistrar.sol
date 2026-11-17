// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.
pragma solidity >=0.8.27;

import { CRISPRemoteProgram } from "./CRISPRemoteProgram.sol";
import { IZKPassportHelper, IZKPassportVerifier } from "./interfaces/IZKPassport.sol";

/// @title ZKPassportRegistrar
/// @notice Registers the voters of {CRISPRemoteProgram} rounds on L1 with a ZKPassport proof.
/// @dev Chain-agnostic. A round names this contract as its `registrar` in its custom parameters; the proof is verified
/// by ZKPassport's root verifier and, when it satisfies the round's rules, {CRISPRemoteProgram.registerMember} sends
/// the voter's slot to the remote chain. Voting then happens on the remote chain, so a voter needs no L1 account:
/// anyone may submit the proof, because it binds the slot (`senderAddress`) and the chain, so nobody can redirect it.
///
/// The scope of every proof is the program's `scopeOf(e3Id)`, so a document's identifier differs per round: it cannot
/// be linked across rounds and registers once per round. The identifier belongs to a document, not a person: a person
/// holding two documents can register twice.
///
/// The rules come from the program, not from the caller: the domain, scope, validity window and mock-document switch
/// of the proof's service configuration are replaced with the round's, so a proof made for another service or round
/// fails verification.
contract ZKPassportRegistrar {
  /// @notice ZKPassport's root verifier (0x1D000001000EFD9a6371f4d90bB8920D5431c0D8 on every supported network).
  IZKPassportVerifier public immutable rootVerifier;
  /// @notice The program whose rounds this contract registers voters for.
  CRISPRemoteProgram public immutable program;
  /// @notice The host name ZKPassport shows the voter, and part of every identifier.
  string public domain;
  /// @notice The maximum age of a proof when it is registered.
  uint256 public immutable validityPeriod;

  /// @notice Whether a document identifier has registered for a round.
  mapping(uint256 e3Id => mapping(bytes32 identifier => bool)) public used;

  event Registered(uint256 indexed e3Id, address indexed slot, bytes32 identifier);

  error InvalidConfig();
  /// @notice The round is unknown, registers voters on the remote chain, or names another registrar.
  error NotRoundRegistrar(uint256 e3Id);
  error RegistrationClosed(uint256 e3Id);
  error CountriesMismatch();
  error InvalidProof();
  error MissingIdentifier();
  error UnexpectedNullifierType();
  error WrongBinding(address senderAddress, uint256 chainId);
  error AgeNotProven(uint256 minAge);
  error NationalityNotProven();
  error DocumentAlreadyRegistered(uint256 e3Id, bytes32 identifier);

  constructor(IZKPassportVerifier rootVerifier_, CRISPRemoteProgram program_, string memory domain_, uint256 validityPeriod_) {
    if (address(rootVerifier_).code.length == 0 || address(program_).code.length == 0) revert InvalidConfig();
    if (bytes(domain_).length == 0 || validityPeriod_ == 0) revert InvalidConfig();

    rootVerifier = rootVerifier_;
    program = program_;
    domain = domain_;
    validityPeriod = validityPeriod_;
  }

  /// @notice Registers `slot` for round `e3Id` with a ZKPassport `compressed-evm` proof.
  /// @param e3Id The round (the program's E3 id).
  /// @param slot The voter's per-round slot: the proof's bound `senderAddress`.
  /// @param params The output of the SDK's `getSolidityVerifierParameters`; its service configuration is replaced.
  /// @param countries The round's country list, as emitted in `RoundRules`; empty when the round has no nationality rule.
  function register(
    uint256 e3Id,
    address slot,
    IZKPassportVerifier.ProofVerificationParams calldata params,
    string[] calldata countries
  ) external {
    CRISPRemoteProgram.Rules memory rules = program.getRules(e3Id);
    if (rules.registrar != address(this)) revert NotRoundRegistrar(e3Id);
    if (block.timestamp >= rules.inputEnd) revert RegistrationClosed(e3Id);
    if (keccak256(abi.encode(countries)) != rules.countriesHash) revert CountriesMismatch();

    IZKPassportVerifier.ProofVerificationParams memory p = params;
    p.serviceConfig = IZKPassportVerifier.ServiceConfig(validityPeriod, domain, program.scopeOf(e3Id), rules.allowMockDocuments);
    (bool verified, bytes32 identifier, IZKPassportHelper helper) = rootVerifier.verify(p);
    if (!verified) revert InvalidProof();
    if (identifier == bytes32(0)) revert MissingIdentifier();

    // A salted and a non-salted identifier of one document differ, so accepting both would let one document register
    // twice. Only non-salted (or, when mock documents are allowed, its mock twin) passes.
    try
      helper.enforceNullifierType(IZKPassportHelper.NullifierType.NON_SALTED_NULLIFIER, params.proofVerificationData.publicInputs)
    {} catch {
      revert UnexpectedNullifierType();
    }

    _checkCommittedInputs(helper, params.committedInputs, slot, rules, countries);

    if (used[e3Id][identifier]) revert DocumentAlreadyRegistered(e3Id, identifier);
    used[e3Id][identifier] = true;
    emit Registered(e3Id, slot, identifier);

    program.registerMember(e3Id, slot);
  }

  function _checkCommittedInputs(
    IZKPassportHelper helper,
    bytes calldata committedInputs,
    address slot,
    CRISPRemoteProgram.Rules memory rules,
    string[] calldata countries
  ) internal view {
    IZKPassportHelper.BoundData memory bound = helper.getBoundData(committedInputs);
    if (bound.senderAddress != slot || bound.chainId != block.chainid) revert WrongBinding(bound.senderAddress, bound.chainId);

    if (rules.minAge != 0 && !helper.isAgeAboveOrEqual(uint8(rules.minAge), committedInputs)) revert AgeNotProven(rules.minAge);
    if (rules.nationalityMode == 1) {
      if (!helper.isNationalityIn(countries, committedInputs)) revert NationalityNotProven();
    } else if (rules.nationalityMode == 2) {
      if (!helper.isNationalityOut(countries, committedInputs)) revert NationalityNotProven();
    }
  }
}
