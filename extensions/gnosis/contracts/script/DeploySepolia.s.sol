// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.
pragma solidity >=0.8.27;

import { Script, console } from "forge-std/Script.sol";
import { IOpenVmReceiptVerifier } from "@interfold/contracts/contracts/interfaces/IOpenVmReceiptVerifier.sol";
import { IDataAvailabilityVerifier } from "@interfold/contracts/contracts/interfaces/IDataAvailabilityVerifier.sol";
import { CRISPGnosisProgram } from "../contracts/l1/CRISPGnosisProgram.sol";
import { IAMB } from "../contracts/interfaces/IAMB.sol";

interface IImageIdSource {
  function imageId() external view returns (bytes32);
}

/// @notice Step 2 of design 11.2: deploy `CRISPGnosisProgram` on Sepolia and allow the proposer. It cannot be wired alone:
///
///   1. this script (the program's `remote` is not known yet);
///   2. `DeployChiado.s.sol` with `PROGRAM` set to the printed address (the voting contract needs the program, immutably);
///   3. `SetRemote.s.sol` with the voting address (one-shot);
///   4. the Interfold owner calls `registerE3Program(program)`, then the program owner `bindInterfold(interfold)`
///      (external dependency: the protocol owner is a governance address, not the deployer).
///
/// Environment: PROPOSER (required, the account that may request a proposal round); optional INITIAL_OWNER (default: the
/// deployer), INTERFOLD, OPENVM_VERIFIER, DA_VERIFIER, FOREIGN_AMB (defaults: the Sepolia deployment the Aztec CRISP program
/// uses and the Gnosis Foreign AMB), MIN_VOTING_DURATION (3600), REMOTE_FINALITY_WINDOW (3600), AMB_LATENCY_MARGIN (1800).
/// Writes `deployments/sepolia.json`.
///
///   forge script script/DeploySepolia.s.sol --rpc-url $SEPOLIA_RPC_URL --broadcast --private-key $KEY
contract DeploySepolia is Script {
  address internal constant INTERFOLD = 0xb35EE9ed8BE5967daabBA8c2e817C52D0b57ac26;
  address internal constant OPENVM_VERIFIER = 0x226436d8A72357c7992896B37f0A2E00dCb6A341;
  address internal constant DA_VERIFIER = 0xB5cDE772357C9dB2d2515Cf94Daa0696c9a2FB17;
  address internal constant FOREIGN_AMB = 0xf2546D6648BD2af6a008A7e7C1542BB240329E11;

  function run() external {
    require(block.chainid == 11155111, "not Sepolia");
    address proposer = vm.envAddress("PROPOSER");

    vm.startBroadcast();
    (, address deployer, ) = vm.readCallers();
    address owner = vm.envOr("INITIAL_OWNER", deployer);

    CRISPGnosisProgram program = _deployProgram(owner);
    if (owner == deployer) program.setProposer(proposer, true);
    else console.log("The program owner must call setProposer(PROPOSER, true).");
    vm.stopBroadcast();

    vm.writeFile("./deployments/sepolia.json", _json(address(program), owner));
  }

  function _deployProgram(address owner) internal returns (CRISPGnosisProgram) {
    address openVm = vm.envOr("OPENVM_VERIFIER", OPENVM_VERIFIER);
    return
      new CRISPGnosisProgram(
        owner,
        IOpenVmReceiptVerifier(openVm),
        IImageIdSource(openVm).imageId(),
        IDataAvailabilityVerifier(vm.envOr("DA_VERIFIER", DA_VERIFIER)),
        vm.envOr("MIN_VOTING_DURATION", uint256(3600)),
        vm.envOr("REMOTE_FINALITY_WINDOW", uint256(3600)),
        IAMB(vm.envOr("FOREIGN_AMB", FOREIGN_AMB)),
        vm.envOr("AMB_LATENCY_MARGIN", uint256(1800))
      );
  }

  function _json(address program, address owner) internal view returns (string memory) {
    return
      string.concat(
        '{\n  "chainId": 11155111,\n  "deployBlock": ', vm.toString(block.number),
        ',\n  "interfold": "', vm.toString(vm.envOr("INTERFOLD", INTERFOLD)),
        '",\n  "program": "', vm.toString(program),
        '",\n  "owner": "', vm.toString(owner),
        '",\n  "foreignAmb": "', vm.toString(vm.envOr("FOREIGN_AMB", FOREIGN_AMB)),
        '",\n  "openVmVerifier": "', vm.toString(vm.envOr("OPENVM_VERIFIER", OPENVM_VERIFIER)),
        '",\n  "dataAvailabilityVerifier": "', vm.toString(vm.envOr("DA_VERIFIER", DA_VERIFIER)),
        '"\n}\n'
      );
  }
}
