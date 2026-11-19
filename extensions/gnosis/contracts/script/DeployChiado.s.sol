// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.
pragma solidity >=0.8.27;

import { IHonkVerifier } from "@crisp-e3/contracts/contracts/interfaces/IHonkVerifier.sol";
import { IVotesToken } from "@crisp-e3/contracts/contracts/interfaces/IVotesToken.sol";
import { HonkVerifier } from "@crisp-e3/contracts/contracts/verifiers/CRISPOnchainVerifier.sol";
import { CrispGnosisVoting } from "../contracts/chiado/CrispGnosisVoting.sol";
import { CrispDemoToken } from "../contracts/chiado/CrispDemoToken.sol";
import { IAMB } from "../contracts/interfaces/IAMB.sol";
import { GovernanceDeployer } from "./GovernanceDeployer.sol";

/// @notice Steps 1, 3 and 6 of design 11.2, on Chiado: the verifier, the demo token, the voting contract and the governance
/// stack (a new Safe 1-of-1 owned by the deployer, a Delay, the governance module), reusing the Safe 1.3.0, MultiSendCallOnly
/// and Zodiac `ModuleProxyFactory` already on Chiado. The Delay and module mastercopies are deployed here (the Delay is the
/// vendored v1.1.1, see `vendor/README.md`). Run `DeploySepolia.s.sol` first: the voting contract needs the program address.
///
/// Environment: PROGRAM (required, the Sepolia program), INPUT_SIGNER (required, the server's attestation address); optional
/// FAUCET (the account that may call `faucetMint`), INTERFOLD (the Sepolia Interfold), HOME_AMB, ONCHAIN_VERIFIER (reuse a
/// deployed `HonkVerifier`), MIN_VOTING_POWER, FAUCET_AMOUNT (1000e18), FAUCET_COOLDOWN (1 day), TREASURY (1,000,000e18),
/// QUORUM (2000e18), APPROVAL_BPS (5000), DELAY_COOLDOWN (300), DELAY_EXPIRATION (3600), PROPOSAL_EXPIRATION (7 days).
/// Writes `deployments/chiado.json`.
///
///   PROGRAM=0x.. INPUT_SIGNER=0x.. forge script script/DeployChiado.s.sol --rpc-url https://rpc.chiadochain.net --broadcast --private-key $KEY
contract DeployChiado is GovernanceDeployer {
  address internal constant INTERFOLD = 0xb35EE9ed8BE5967daabBA8c2e817C52D0b57ac26;
  address internal constant HOME_AMB = 0x8448E15d0e706C0298dECA99F0b4744030e59d7d;
  address internal constant AMB_HELPER = 0x3cc500B3c01D04C265c9293cB35BA2Fd8eA6dc1b;
  address internal constant SAFE_SINGLETON = 0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552;
  address internal constant SAFE_PROXY_FACTORY = 0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2;
  address internal constant MULTI_SEND_CALL_ONLY = 0x40A2aCCbd92BCA938b02010E17A5b8929b49130D;
  address internal constant MODULE_PROXY_FACTORY = 0x000000000000aDdB49795b0f9bA5BC298cDda236;

  struct Deployed {
    address token;
    address onchainVerifier;
    address voting;
  }

  function run() external {
    require(block.chainid == 10200, "not Chiado");
    address program = vm.envAddress("PROGRAM");
    address inputSigner = vm.envAddress("INPUT_SIGNER");

    vm.startBroadcast();
    (, address deployer, ) = vm.readCallers();
    Deployed memory d = _deployVoting(deployer, program, inputSigner);

    GovernanceDeployer.Governance memory gov = _deployGovernance(
      GovernanceDeployer.GovernanceConfig({
        deployer: deployer,
        safeSingleton: SAFE_SINGLETON,
        safeProxyFactory: SAFE_PROXY_FACTORY,
        moduleProxyFactory: MODULE_PROXY_FACTORY,
        multiSend: MULTI_SEND_CALL_ONLY,
        voting: d.voting,
        delayCooldown: vm.envOr("DELAY_COOLDOWN", uint256(300)),
        delayExpiration: vm.envOr("DELAY_EXPIRATION", uint256(3600)),
        quorum: vm.envOr("QUORUM", uint256(2_000e18)),
        approvalBps: uint16(vm.envOr("APPROVAL_BPS", uint256(5_000))),
        expiration: uint64(vm.envOr("PROPOSAL_EXPIRATION", uint256(7 days)))
      })
    );
    CrispDemoToken(d.token).mintTreasury(gov.safe, vm.envOr("TREASURY", uint256(1_000_000e18)));
    vm.stopBroadcast();

    vm.writeFile("./deployments/chiado.json", _json(program, d, gov));
  }

  function _deployVoting(address deployer, address program, address inputSigner) internal returns (Deployed memory d) {
    address verifier = vm.envOr("ONCHAIN_VERIFIER", address(0));
    if (verifier == address(0)) verifier = address(new HonkVerifier());
    d.onchainVerifier = verifier;

    CrispDemoToken token = new CrispDemoToken(deployer, vm.envOr("FAUCET_AMOUNT", uint256(1_000e18)), vm.envOr("FAUCET_COOLDOWN", uint256(1 days)));
    address faucet = vm.envOr("FAUCET", address(0));
    if (faucet != address(0)) token.setFaucet(faucet);
    d.token = address(token);

    d.voting = address(
      new CrispGnosisVoting(
        IAMB(vm.envOr("HOME_AMB", HOME_AMB)),
        vm.envOr("INTERFOLD", INTERFOLD),
        program,
        IVotesToken(d.token),
        IHonkVerifier(verifier),
        inputSigner,
        vm.envOr("MIN_VOTING_POWER", uint256(0))
      )
    );
  }

  function _json(address program, Deployed memory d, GovernanceDeployer.Governance memory gov) internal view returns (string memory json) {
    json = string.concat(
      '{\n  "chainId": 10200,\n  "deployBlock": ', vm.toString(block.number),
      ',\n  "program": "', vm.toString(program),
      '",\n  "homeAmb": "', vm.toString(vm.envOr("HOME_AMB", HOME_AMB)),
      '",\n  "ambHelper": "', vm.toString(AMB_HELPER),
      '",\n  "voting": "', vm.toString(d.voting),
      '",\n  "token": "', vm.toString(d.token),
      '",\n  "onchainVerifier": "', vm.toString(d.onchainVerifier)
    );
    json = string.concat(
      json,
      '",\n  "safe": "', vm.toString(gov.safe),
      '",\n  "delayMastercopy": "', vm.toString(gov.delayMastercopy),
      '",\n  "delay": "', vm.toString(gov.delay),
      '",\n  "moduleMastercopy": "', vm.toString(gov.moduleMastercopy),
      '",\n  "module": "', vm.toString(gov.module),
      '",\n  "moduleProxyFactory": "', vm.toString(MODULE_PROXY_FACTORY),
      '",\n  "multiSend": "', vm.toString(MULTI_SEND_CALL_ONLY),
      '",\n  "multiSendCallOnly": "', vm.toString(MULTI_SEND_CALL_ONLY),
      '"\n}\n'
    );
  }
}
