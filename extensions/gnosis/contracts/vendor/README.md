# Vendored sources

The Foundry project compiles these from source; none is an npm dependency, because the Delay needs a pinned older
Zodiac/OpenZeppelin generation next to the 4.3.1 one the governance module uses. Every file is verbatim unless listed under
"Changes".

| Directory | Upstream | Version | Used by |
| --- | --- | --- | --- |
| `zodiac-core/` | `@gnosis-guild/zodiac-core` (`core/{Module,Operation}`, `factory/*`, `interfaces/IAvatar`) | 4.3.1 | `CrispGovernanceModule`, `ModuleProxyFactory` in tests and scripts |
| `zodiac-modifier-delay/Delay.sol` | github.com/zodiaceco/zodiac-modifier-delay, branch `v1.1.1` | 1.1.1 ("Patch SignatureChecker bug") | the Delay in tests and the deploy scripts |
| `zodiac-core-2.1.2/` | `@gnosis-guild/zodiac-core` (`core/{Modifier,Module}`, `factory/FactoryFriendly`, `interfaces/IAvatar`, `signature/*`) | 2.1.2, the version Delay 1.1.1 pins | `Delay.sol` only |
| `openzeppelin-contracts-upgradeable-5.0.2/` | `@openzeppelin/contracts-upgradeable` (`Initializable`, `OwnableUpgradeable`, `ContextUpgradeable`) | 5.0.2, as pinned by zodiac-core 2.1.2 | `zodiac-core-2.1.2` only |
| `safe-contracts/` | `@gnosis.pm/safe-contracts` | 1.3.0 | the Safe in tests and the local deploy (Chiado already hosts the same singleton, proxy factory and `MultiSendCallOnly`) |

## Why Delay 1.1.1 and not a tag

The only tags of the Delay repository are `v1.0.1` and `v1.1.0`. The `v1.1.0` `SignatureChecker` ignores the success flag of the
EIP-1271 `staticcall` (`bytes4(returnData) == MAGIC` on a failed call reads stale memory), which the `v1.1.1` branch fixes
("Patch SignatureChecker bug"). A Safe-controlling module whose base library carries a known signature bug is not one to
ship, so the branch is vendored. `main` of that repository is an unreleased 2.0.0 on a zodiac-core
alpha and is not used. The mastercopy the scripts deploy is this source; the Delay 1.0.1 mastercopy already on Chiado is not used.

## Changes

- `zodiac-core-2.1.2/signature/SignatureChecker.sol`: line 135 is `return success && bytes4(returnData) == EIP1271_MAGIC_VALUE;`
  (upstream's package ships the unpatched `return bytes4(returnData) == EIP1271_MAGIC_VALUE;` and Delay's `postinstall` rewrites it
  with `patch-signature-checker.cjs`; the rewrite is applied here once, to the vendored copy).
- `zodiac-modifier-delay/Delay.sol`: the single import is relative (`../zodiac-core-2.1.2/core/Modifier.sol`) instead of
  `@gnosis-guild/zodiac-core/contracts/core/Modifier.sol`, which `remappings.txt` points at 4.3.1 for everything else.
- `remappings.txt` carries two context remappings so the 2.1.2 tree finds its own Safe and OpenZeppelin-upgradeable imports.
