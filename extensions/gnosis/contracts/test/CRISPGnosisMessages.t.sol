// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.
pragma solidity >=0.8.27;

import { Test } from "forge-std/Test.sol";
import { CRISPRemoteMessages } from "@crisp-e3/extension-core/contracts/CRISPRemoteMessages.sol";
import { CRISPGnosisMessages } from "../contracts/lib/CRISPGnosisMessages.sol";

/// @dev Exposes the internal library to `vm.expectRevert`, which needs an external call.
contract MessagesHarness {
  function decodeRound(bytes memory message) external pure returns (CRISPGnosisMessages.RoundMessage memory) {
    return CRISPGnosisMessages.decodeRound(message);
  }

  function round(CRISPGnosisMessages.RoundMessage memory m) external pure returns (bytes memory) {
    return CRISPGnosisMessages.round(m);
  }
}

/// @notice The four message layouts, byte for byte; `test_writeVectors` writes `test/fixtures/message-vectors.json`, which the
/// TypeScript encoders (`extensions/gnosis/sdk`) are tested against.
contract CRISPGnosisMessagesTest is Test {
  MessagesHarness internal harness = new MessagesHarness();

  bytes32 internal constant PROPOSAL_HASH = keccak256("packed batch");
  address internal constant REQUESTER = 0x70997970C51812dc3A010C7d01b50e0d17dc79C8;
  string internal constant CID = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";

  function _round() internal pure returns (CRISPGnosisMessages.RoundMessage memory m) {
    m.roundId = 7;
    m.numOptions = 3;
    m.inputStart = 1_800_000_000;
    m.inputEnd = 1_800_003_600;
    m.inputLimit = 65_536;
    m.plaintextModulus = 17_000_000;
    m.snapshot = 1_799_999_999;
    m.censusMode = 0;
    m.censusRoot = bytes32(0);
    m.censusTotal = 0;
    m.proposalHash = PROPOSAL_HASH;
    m.requester = REQUESTER;
    m.metadataCid = CID;
  }

  /// @dev Built word by word, independently of `abi.encode`: kind, 12 words, the string offset (14 words of head = 0x1c0),
  /// then the string length and its right-padded bytes.
  function _expectedRound(CRISPGnosisMessages.RoundMessage memory m) internal pure returns (bytes memory) {
    bytes memory cid = bytes(m.metadataCid);
    uint256 padded = (cid.length + 31) / 32 * 32;
    bytes memory data = new bytes(padded);
    for (uint256 i = 0; i < cid.length; i++) data[i] = cid[i];

    bytes memory head = bytes.concat(
      bytes32(uint256(1)),
      bytes32(m.roundId),
      bytes32(m.numOptions),
      bytes32(m.inputStart),
      bytes32(m.inputEnd),
      bytes32(m.inputLimit),
      bytes32(m.plaintextModulus),
      bytes32(m.snapshot)
    );
    head = bytes.concat(
      head,
      bytes32(m.censusMode),
      m.censusRoot,
      bytes32(m.censusTotal),
      m.proposalHash,
      bytes32(uint256(uint160(m.requester))),
      bytes32(uint256(0x1c0))
    );
    return bytes.concat(head, bytes32(cid.length), data);
  }

  function test_roundLayout() public pure {
    CRISPGnosisMessages.RoundMessage memory m = _round();
    bytes memory encoded = CRISPGnosisMessages.round(m);

    assertEq(encoded, _expectedRound(m));
    // 14 head words + length + padded data (59 bytes of CID -> 2 words).
    assertEq(encoded.length, 14 * 32 + 32 + 64);
    // The head offset of the string is the size of the head.
    assertEq(uint256(bytes32(_word(encoded, 13))), 0x1c0);
  }

  function test_roundDecodeRoundTrip() public view {
    bytes memory encoded = CRISPGnosisMessages.round(_round());
    CRISPGnosisMessages.RoundMessage memory d = harness.decodeRound(encoded);

    assertEq(d.kind, 1);
    assertEq(d.roundId, 7);
    assertEq(d.numOptions, 3);
    assertEq(d.inputStart, 1_800_000_000);
    assertEq(d.inputEnd, 1_800_003_600);
    assertEq(d.inputLimit, 65_536);
    assertEq(d.plaintextModulus, 17_000_000);
    assertEq(d.snapshot, 1_799_999_999);
    assertEq(d.censusMode, 0);
    assertEq(d.censusRoot, bytes32(0));
    assertEq(d.censusTotal, 0);
    assertEq(d.proposalHash, PROPOSAL_HASH);
    assertEq(d.requester, REQUESTER);
    assertEq(d.metadataCid, CID);
  }

  function test_roundEncodingForcesKindRound() public pure {
    CRISPGnosisMessages.RoundMessage memory m = _round();
    m.kind = 99;
    assertEq(uint256(bytes32(_word(CRISPGnosisMessages.round(m), 0))), 1);
  }

  function testFuzz_roundRoundTrips(
    uint256 roundId,
    uint256 inputStart,
    uint256 inputEnd,
    uint256 t,
    uint256 snapshot,
    bytes32 proposalHash,
    address requester,
    string calldata cid
  ) public view {
    CRISPGnosisMessages.RoundMessage memory m = _round();
    m.roundId = roundId;
    m.inputStart = inputStart;
    m.inputEnd = inputEnd;
    m.plaintextModulus = t;
    m.snapshot = snapshot;
    m.proposalHash = proposalHash;
    m.requester = requester;
    m.metadataCid = cid;

    bytes memory encoded = CRISPGnosisMessages.round(m);
    assertEq(encoded, _expectedRound(m));

    CRISPGnosisMessages.RoundMessage memory d = harness.decodeRound(encoded);
    assertEq(d.roundId, roundId);
    assertEq(d.plaintextModulus, t);
    assertEq(d.proposalHash, proposalHash);
    assertEq(d.requester, requester);
    assertEq(d.metadataCid, cid);
  }

  function test_decodeRoundRejectsOtherLayouts() public {
    // A 12-word Aztec ROUND is not a Gnosis ROUND.
    CRISPRemoteMessages.RoundConfig memory aztec;
    aztec.roundId = 7;
    vm.expectRevert();
    harness.decodeRound(CRISPRemoteMessages.round(aztec));

    vm.expectRevert();
    harness.decodeRound("");
  }

  function test_keyAndRootAreTheCoreLayouts() public pure {
    bytes32 key = keccak256("committee key");
    assertEq(CRISPRemoteMessages.committeeKey(7, key), abi.encode(uint256(2), uint256(7), key));
    assertEq(CRISPRemoteMessages.inputRoot(7, 123, 4), abi.encode(uint256(3), uint256(7), uint256(123), uint256(4)));
    assertEq(CRISPGnosisMessages.KIND_KEY, 2);
    assertEq(CRISPGnosisMessages.KIND_ROOT, 3);
  }

  function test_resultLayout() public pure {
    uint256[] memory tally = new uint256[](3);
    tally[0] = 5;
    tally[1] = 2;
    tally[2] = 1;
    bytes memory encoded = CRISPGnosisMessages.result(7, tally);

    // kind, roundId, offset (0x60), length, 3 entries.
    assertEq(encoded, bytes.concat(bytes32(uint256(4)), bytes32(uint256(7)), bytes32(uint256(0x60)), bytes32(uint256(3)), bytes32(uint256(5)), bytes32(uint256(2)), bytes32(uint256(1))));

    (uint256 roundId, uint256[] memory decoded) = CRISPGnosisMessages.decodeResult(encoded);
    assertEq(roundId, 7);
    assertEq(decoded, tally);
  }

  function test_kindOf() public pure {
    assertEq(CRISPGnosisMessages.kindOf(CRISPGnosisMessages.round(_round())), 1);
    assertEq(CRISPGnosisMessages.kindOf(CRISPRemoteMessages.committeeKey(7, bytes32(uint256(1)))), 2);
    assertEq(CRISPGnosisMessages.kindOf(CRISPRemoteMessages.inputRoot(7, 1, 1)), 3);
  }

  function test_gasLimitsFitTheBridge() public pure {
    // Foreign -> Home (ROUND, KEY, RESULT) and Home -> Foreign (ROOT) maxima observed on Sepolia/Chiado: 4M and 2M.
    assertLe(CRISPGnosisMessages.ROUND_GAS, 4_000_000);
    assertLe(CRISPGnosisMessages.KEY_GAS, 4_000_000);
    assertLe(CRISPGnosisMessages.RESULT_GAS, 4_000_000);
    assertLe(CRISPGnosisMessages.ROOT_GAS, 2_000_000);
  }

  /// @dev Writes the vectors the TypeScript side is tested against. Run with the rest of the suite; the file is tracked.
  /// Numbers are decimal strings (they exceed what JSON numbers carry), words and addresses are 0x hex.
  function test_writeVectors() public {
    bytes32 key = keccak256("committee key");
    uint256[] memory tally = new uint256[](3);
    tally[0] = 5;
    tally[1] = 2;
    tally[2] = 1;
    CRISPGnosisMessages.RoundMessage memory m = _round();

    string memory roundFields = string.concat(
      '{"roundId":"', vm.toString(m.roundId),
      '","numOptions":"', vm.toString(m.numOptions),
      '","inputStart":"', vm.toString(m.inputStart),
      '","inputEnd":"', vm.toString(m.inputEnd),
      '","inputLimit":"', vm.toString(m.inputLimit),
      '","plaintextModulus":"', vm.toString(m.plaintextModulus),
      '","snapshot":"', vm.toString(m.snapshot)
    );
    roundFields = string.concat(
      roundFields,
      '","censusMode":"', vm.toString(m.censusMode),
      '","censusRoot":"', vm.toString(m.censusRoot),
      '","censusTotal":"', vm.toString(m.censusTotal),
      '","proposalHash":"', vm.toString(m.proposalHash),
      '","requester":"', vm.toString(m.requester),
      '","metadataCid":"', m.metadataCid, '"}'
    );

    string memory json = string.concat(
      '{"round":{"fields":', roundFields, ',"abiEncoded":"', vm.toString(CRISPGnosisMessages.round(m)), '"},'
    );
    json = string.concat(
      json,
      '"key":{"fields":{"roundId":"7","committeePublicKey":"', vm.toString(key),
      '"},"abiEncoded":"', vm.toString(CRISPRemoteMessages.committeeKey(7, key)), '"},'
    );
    json = string.concat(
      json,
      '"root":{"fields":{"roundId":"7","root":"123456789","numInputs":"4"},"abiEncoded":"',
      vm.toString(CRISPRemoteMessages.inputRoot(7, 123456789, 4)), '"},'
    );
    json = string.concat(
      json,
      '"result":{"fields":{"roundId":"7","tally":["5","2","1"]},"abiEncoded":"', vm.toString(CRISPGnosisMessages.result(7, tally)), '"},'
    );
    json = string.concat(
      json,
      '"gasLimits":{"round":', vm.toString(CRISPGnosisMessages.ROUND_GAS),
      ',"key":', vm.toString(CRISPGnosisMessages.KEY_GAS),
      ',"root":', vm.toString(CRISPGnosisMessages.ROOT_GAS),
      ',"result":', vm.toString(CRISPGnosisMessages.RESULT_GAS), '}}'
    );
    vm.writeFile("./test/fixtures/message-vectors.json", json);
  }

  function _word(bytes memory data, uint256 index) internal pure returns (bytes memory word) {
    word = new bytes(32);
    for (uint256 i = 0; i < 32; i++) word[i] = data[index * 32 + i];
  }
}
