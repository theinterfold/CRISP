// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

use alloy::{
    primitives::{keccak256, Address, B256, U256},
    signers::{local::PrivateKeySigner, SignerSync},
    sol,
    sol_types::{eip712_domain, Eip712Domain, SolStruct, SolValue},
};

sol! {
    /// The statement the availability signer attests to. The typehash and the domain are those of
    /// `CRISPProgram.inputAvailabilityDigest`, with the remote program as verifying contract.
    struct InputAvailability {
        uint256 e3Id;
        bytes32 inputId;
        uint64 expiresAt;
    }
}

/// `parentIndexPlusOne` is a `uint40` in every CRISP contract.
const PARENT_INDEX_LIMIT: u64 = 1 << 40;

/// What one input is, before the remote contract accepts it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct InputStatement {
    pub e3_id: U256,
    pub ciphertext_hash: B256,
    pub commitment: B256,
    pub slot: Address,
    pub parent_index_plus_one: u64,
}

impl InputStatement {
    pub fn new(
        e3_id: U256,
        ciphertext_hash: B256,
        commitment: B256,
        slot: Address,
        parent_index_plus_one: u64,
    ) -> eyre::Result<Self> {
        eyre::ensure!(
            parent_index_plus_one < PARENT_INDEX_LIMIT,
            "parentIndexPlusOne does not fit in a uint40"
        );
        Ok(Self {
            e3_id,
            ciphertext_hash,
            commitment,
            slot,
            parent_index_plus_one,
        })
    }
}

/// The identifier of an input, as `CRISPProgram.inputId` derives it with the remote program in
/// place of `address(this)`. It binds the program and the round, so an attestation cannot be
/// replayed into another deployment or round.
pub fn input_id(program: Address, statement: &InputStatement) -> B256 {
    keccak256(
        (
            "CRISP_INPUT_V1",
            program,
            statement.e3_id,
            statement.ciphertext_hash,
            statement.commitment,
            statement.slot,
            U256::from(statement.parent_index_plus_one),
        )
            .abi_encode_params(),
    )
}

/// An attestation the remote contract verifies with secp256k1.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Attestation {
    pub input_id: B256,
    pub expires_at: u64,
    /// `r || s` of the signature over the EIP-712 digest, with `s` in the lower half of the curve
    /// order. A circuit that verifies a bare ECDSA signature takes no recovery byte.
    pub signature: [u8; 64],
    pub signer: Address,
}

/// Signs `InputAvailability` for one remote program.
#[derive(Clone)]
pub struct AvailabilityAttester {
    signer: PrivateKeySigner,
    domain: Eip712Domain,
    program: Address,
}

impl AvailabilityAttester {
    /// `program` is the L1 program contract and `chain_id` the L1 chain it runs on: the domain of
    /// the attestation is the domain of that contract.
    pub fn new(signer: PrivateKeySigner, chain_id: u64, program: Address) -> Self {
        Self {
            signer,
            domain: eip712_domain! {
                name: "CRISP",
                version: "1",
                chain_id: chain_id,
                verifying_contract: program,
            },
            program,
        }
    }

    pub fn signer_address(&self) -> Address {
        self.signer.address()
    }

    /// The uncompressed secp256k1 public key, `x || y`. A contract that verifies the bare
    /// signature stores this rather than the address, which cannot verify one.
    pub fn signer_public_key(&self) -> [u8; 64] {
        let point = self
            .signer
            .credential()
            .verifying_key()
            .to_encoded_point(false);
        point.as_bytes()[1..]
            .try_into()
            .expect("an uncompressed point is a tag and two 32-byte coordinates")
    }

    /// The EIP-712 digest of the attestation of `id` until `expires_at`.
    pub fn digest(&self, e3_id: U256, id: B256, expires_at: u64) -> B256 {
        InputAvailability {
            e3Id: e3_id,
            inputId: id,
            expiresAt: expires_at,
        }
        .eip712_signing_hash(&self.domain)
    }

    pub fn attest(&self, statement: &InputStatement, expires_at: u64) -> eyre::Result<Attestation> {
        let input_id = input_id(self.program, statement);
        let digest = self.digest(statement.e3_id, input_id, expires_at);
        let signature = self
            .signer
            .sign_hash_sync(&digest)
            .map_err(|error| eyre::eyre!("failed to attest input availability: {error}"))?;
        // alloy signs with a normalized `s`; a signature that was not would be rejected by the
        // verifier, so refuse to hand one out.
        eyre::ensure!(
            signature.normalize_s().is_none(),
            "the availability signature is not normalized"
        );
        let mut rs = [0u8; 64];
        rs[..32].copy_from_slice(&signature.r().to_be_bytes::<32>());
        rs[32..].copy_from_slice(&signature.s().to_be_bytes::<32>());
        Ok(Attestation {
            input_id,
            expires_at,
            signature: rs,
            signer: self.signer.address(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy::primitives::{address, b256};

    const PROGRAM: Address = address!("0x00000000000000000000000000000000000000a1");

    fn statement() -> InputStatement {
        InputStatement::new(
            U256::from(7),
            B256::repeat_byte(0x11),
            b256!("0x0000000000000000000000000000000000000000000000000000000000000022"),
            address!("0x0000000000000000000000000000000000000033"),
            5,
        )
        .unwrap()
    }

    /// `cast keccak $(cast abi-encode "f(string,address,uint256,bytes32,bytes32,address,uint40)"
    /// CRISP_INPUT_V1 <program> 7 <hash> <commitment> <slot> 5)`, which is
    /// `abi.encode("CRISP_INPUT_V1", program, e3Id, hash, commitment, slot, parent)` in
    /// `CRISPProgram.inputId`.
    #[test]
    fn the_input_id_is_the_solidity_encoding() {
        assert_eq!(
            input_id(PROGRAM, &statement()),
            b256!("0xd103ae75cd08b75f9e15f87410d7ba6e7727c7bdd52c6aea35e3910094a8225e")
        );
    }

    /// A real Interfold E3 id, `interfold << 96 | 7` of the message vectors' worked example, is
    /// above the BN254 modulus. The server and L1 use it whole in the input id and the digest; only
    /// the Aztec contract narrows it, and it rebuilds the full value before hashing.
    #[test]
    fn a_full_size_e3_id_is_hashed_and_signed_whole() {
        let e3_id = U256::from_str_radix(
            "dfa59d66c173a00643ebe80e172af5a8cf244b30000000000000000000000007",
            16,
        )
        .unwrap();
        let modulus = U256::from_str_radix(
            "30644e72e131a029b85045b68181585d2833e84879b9709143e1f593f0000001",
            16,
        )
        .unwrap();
        assert!(e3_id > modulus);
        let mut statement = statement();
        statement.e3_id = e3_id;

        // `cast keccak $(cast abi-encode ...)` over the same fields with this e3Id.
        let id = input_id(PROGRAM, &statement);
        assert_eq!(
            id,
            b256!("0xd63150e1ff65ac916d8ffb2179b925c301d6d28a51d04fa29a59f659a1478713")
        );

        let signer = PrivateKeySigner::random();
        let attester = AvailabilityAttester::new(signer.clone(), 31_337, PROGRAM);
        let attestation = attester.attest(&statement, 900).unwrap();
        assert_eq!(attestation.input_id, id);
        // The digest covers the full e3Id, so it differs from that of round id 7 alone.
        assert_ne!(
            attester.digest(e3_id, id, 900),
            attester.digest(U256::from(7), id, 900)
        );
    }

    /// `_hashTypedDataV4(keccak256(abi.encode(TYPEHASH, e3Id, id, expiresAt)))` of OpenZeppelin's
    /// EIP712 with name "CRISP" and version "1", computed here from its definition.
    #[test]
    fn the_digest_is_the_openzeppelin_typed_data_hash() {
        let attester = AvailabilityAttester::new(PrivateKeySigner::random(), 31_337, PROGRAM);
        let id = B256::repeat_byte(0x44);

        let typehash =
            keccak256("InputAvailability(uint256 e3Id,bytes32 inputId,uint64 expiresAt)");
        let struct_hash = keccak256((typehash, U256::from(7), id, U256::from(900u64)).abi_encode());
        let domain_typehash = keccak256(
            "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)",
        );
        let domain_separator = keccak256(
            (
                domain_typehash,
                keccak256("CRISP"),
                keccak256("1"),
                U256::from(31_337),
                PROGRAM,
            )
                .abi_encode(),
        );
        let mut preimage = vec![0x19, 0x01];
        preimage.extend_from_slice(domain_separator.as_slice());
        preimage.extend_from_slice(struct_hash.as_slice());

        assert_eq!(attester.digest(U256::from(7), id, 900), keccak256(preimage));
    }

    #[test]
    fn the_signature_recovers_to_the_signer_over_the_digest() {
        let signer = PrivateKeySigner::random();
        let attester = AvailabilityAttester::new(signer.clone(), 31_337, PROGRAM);
        let statement = statement();

        let attestation = attester.attest(&statement, 900).unwrap();

        assert_eq!(attestation.signer, signer.address());
        assert_eq!(attestation.input_id, input_id(PROGRAM, &statement));
        let digest = attester.digest(statement.e3_id, attestation.input_id, 900);
        let recovered = [27u8, 28u8].into_iter().find_map(|v| {
            let mut bytes = attestation.signature.to_vec();
            bytes.push(v);
            alloy::primitives::Signature::from_raw(&bytes)
                .ok()?
                .recover_address_from_prehash(&digest)
                .ok()
                .filter(|address| *address == signer.address())
        });
        assert_eq!(recovered, Some(signer.address()));
    }

    /// The contract stores the key, and the server publishes the address: they must be one signer.
    #[test]
    fn the_public_key_is_the_one_behind_the_address() {
        let attester = AvailabilityAttester::new(PrivateKeySigner::random(), 31_337, PROGRAM);

        let hash = alloy::primitives::keccak256(attester.signer_public_key());

        assert_eq!(Address::from_slice(&hash[12..]), attester.signer_address());
    }

    #[test]
    fn a_parent_index_beyond_uint40_is_refused() {
        assert!(
            InputStatement::new(U256::ZERO, B256::ZERO, B256::ZERO, Address::ZERO, 1 << 40)
                .is_err()
        );
    }
}
