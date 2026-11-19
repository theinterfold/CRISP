// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.
pragma solidity >=0.8.27;

import { Script } from "forge-std/Script.sol";
import { CRISPGnosisProgram } from "../contracts/l1/CRISPGnosisProgram.sol";

/// @notice Step 4 of design 11.2, on Sepolia, as the program owner: point the program at the Chiado voting contract (one-shot).
///
///   PROGRAM=0x.. VOTING=0x.. forge script script/SetRemote.s.sol --rpc-url $SEPOLIA_RPC_URL --broadcast --private-key $KEY
contract SetRemote is Script {
  function run() external {
    vm.startBroadcast();
    CRISPGnosisProgram(vm.envAddress("PROGRAM")).setRemote(vm.envAddress("VOTING"));
    vm.stopBroadcast();
  }
}
