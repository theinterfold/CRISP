// Agreement of the Noir trees and encodings with the Solidity code they replace.
//
// Roots come from zk-kit `InternalLazyIMT` / `InternalLeanIMT` (2.0.0-beta.12 / 2.0.1) run under forge on leaves
// `leaf_i = (i + 1) * 1234567890123456789`. Fixture roots are the `inputRoot` values the real `CRISPProgram` produced
// in `packages/crisp-contracts/tests/fixtures`. Digests are viem `hashTypedData` / `encodeAbiParameters` values;
// message contents are `extensions/aztec/l1/tests/fixtures/message-vectors.json`.

use crate::messages::round_content;
use crisp_aztec_lib::{
    ballot::{ciphertext_commitment, crisp_public_inputs, pk_commitment},
    constants::{BALLOT_TYPEHASH, INPUT_AVAILABILITY_TYPEHASH, LAZY_ZEROS},
    hashing::{
        availability_digest, ballot_digest, from_halves, full_e3_id, input_id, input_leaf, key_content, root_content,
        to_halves,
    },
    tree::{lazy_insert, lazy_root, lean_insert, lean_root, NodeStore},
};
use aztec::protocol::address::EthAddress;
use keccak256::keccak256;
use poseidon::poseidon::bn254::hash_2;

struct MemNodes {
    nodes: [Field; 17],
}

impl NodeStore for MemNodes {
    unconstrained fn get(self, level: u32) -> Field {
        self.nodes[level]
    }

    unconstrained fn set(&mut self, level: u32, value: Field) {
        self.nodes[level] = value;
    }
}

fn leaf(i: u32) -> Field {
    (i as Field + 1) * 1234567890123456789
}

global LAZY_ROOTS: [(u32, Field); 20] = [
    (0, 0x2098f5fb9e239eab3ceac3f27b81e481dc3124d55ffed523a839ee8446b64864),
    (1, 0x18c212cb2b7c30b81d22408e88f839499162f61849e4e85dd9f3add45c19b423),
    (2, 0x158b7fb198bbaf118a16a60ab3fff877265f5ec988c919abea05fea38288a489),
    (3, 0x1345815bd1c9c198729c078447f16f4f861a145a16b4f1d5c3545c9559fe75fa),
    (4, 0x086192c4d7d30a374a10deaf6cedd9cb3b3c2597661126185cdd6d9891b73e71),
    (5, 0x1333f32ed2dd7447fd118c3a181e926a59a93b82fa958b4126449c983ba86348),
    (6, 0x2ee31bafbd17e0227c4b0950c52f17d19652d05a5f39d9c2eb11304866039ee7),
    (7, 0x02389137862931af314f336b59817aed9d5ae7ec458b764a5298a136e8c5a427),
    (8, 0x1655e9147f316518b0ddf70864b5451bbafd2681c85e7bf1c89646e73e867ed7),
    (9, 0x0076c09200c299c8c552bc0172aa1392bc92b54048ca542353db28b90f645fdb),
    (15, 0x1b260671dae8366537d601461d6e725d75a5aaf73e05933b9b83b0b735985a4a),
    (16, 0x11437aeca7a590a2da2b733ace5cf8ef0e0e340e12474391532e50b55461e8a9),
    (17, 0x019b9a8ef5318c365945e68ba7641b5707fb59b5375536a6119353d853467fd7),
    (31, 0x1493fa88a480eefa2f6b260d2e31e171eac9bcabcfb3d871aa76e8a493436ad6),
    (32, 0x19417ececdfae2ff263c313886f554b9f61a9aaa702c1d2e040b9635147a9d18),
    (33, 0x2dce7200ea77b2bb4ee748cde0ad8b0edd252041106609535270f01e5f540fbb),
    (63, 0x0a895c1556b5dec673d769133108e29beb6cb4352fe35c99fe6d8a442e48fee6),
    (64, 0x11c98a88cbb6f6d12dbdc6a5ec9ece67f01c5a042243983d2ee239b5d254ea84),
    (65, 0x1c6a8c37d496d7b7819b13a3cc9fdfc86647e7878a7cf62580347363f295e877),
    (70, 0x2a88c891c3accc858367977315cf5e6aef362d9a30c7cd8608766d2b17438cbe),
];

global LEAN_ROOTS: [(u32, Field); 13] = [
    (1, 0x000000000000000000000000000000000000000000000000112210f47de98115),
    (2, 0x158b7fb198bbaf118a16a60ab3fff877265f5ec988c919abea05fea38288a489),
    (3, 0x287646631d53f024f52fb4260ad15664f25077d65bce4faf1dcbc2e718f4dc7c),
    (4, 0x086192c4d7d30a374a10deaf6cedd9cb3b3c2597661126185cdd6d9891b73e71),
    (5, 0x1221e1aabe65e4618ab6080e7a2720c053442ad81b9d28e728d27affbd665c1e),
    (7, 0x00e39cc88c262fd1511f216ba575c0fe101506cda78ec8a3a8cc2c8c2256c1e6),
    (8, 0x1655e9147f316518b0ddf70864b5451bbafd2681c85e7bf1c89646e73e867ed7),
    (9, 0x0bdd550ad2c96b99d66e97e5592cbedb51a59ba1df8fcbe6a493c4ec4d32638a),
    (17, 0x1f095f603dd709c08f4edeb265ca29db1416fa51176a15778334623eec694189),
    (33, 0x0418dc83b01e74ccc57266faf11a40dd7abce64e3d861a3e9a11b56ec6ed3db8),
    (64, 0x11c98a88cbb6f6d12dbdc6a5ec9ece67f01c5a042243983d2ee239b5d254ea84),
    (65, 0x23215385dd44b1684d546fce67b85e5088ede39e78f92a008dd109418ce66844),
    (70, 0x20f92ced2cadf4d310ad8528703c4b2faa6223808fd5bb097363700026bfa693),
];

unconstrained fn lazy_root_after(count: u32) -> Field {
    let mut store = MemNodes { nodes: [0; 17] };
    for i in 0..count {
        lazy_insert(&mut store, i, leaf(i));
    }
    lazy_root(&mut store, count)
}

#[test]
unconstrained fn lazy_roots_match_zk_kit() {
    for k in 0..LAZY_ROOTS.len() {
        let (n, root) = LAZY_ROOTS[k];
        assert_eq(lazy_root_after(n), root);
    }
}

#[test]
unconstrained fn lazy_zeros_are_empty_subtree_roots() {
    for level in 0..16 {
        assert_eq(hash_2([LAZY_ZEROS[level], LAZY_ZEROS[level]]), LAZY_ZEROS[level + 1]);
    }
}

#[test]
unconstrained fn lean_roots_match_zk_kit() {
    let mut store = MemNodes { nodes: [0; 17] };
    let mut next = 0;
    for i in 0..70 {
        let root = lean_insert(&mut store, i, leaf(i));
        assert_eq(lean_root(&mut store, i + 1), root);
        if (next < LEAN_ROOTS.len()) & (LEAN_ROOTS[next].0 == i + 1) {
            assert_eq(root, LEAN_ROOTS[next].1);
            next += 1;
        }
    }
    assert_eq(next, LEAN_ROOTS.len());
}

#[test]
unconstrained fn empty_census_root_is_zero() {
    let mut store = MemNodes { nodes: [0; 17] };
    assert_eq(lean_root(&mut store, 0), 0);
}

// The full tree at the capacity the contract allows: the top level holds the root.
#[test]
unconstrained fn lazy_tree_at_capacity() {
    let mut store = MemNodes { nodes: [0; 17] };
    // Only the frontier matters for the last insert, so start from a frontier of all-ones positions.
    for level in 0..16 {
        store.nodes[level] = leaf(level);
    }
    lazy_insert(&mut store, 65535, 7);
    let mut expected = 7;
    for level in 0..16 {
        expected = hash_2([leaf(level), expected]);
    }
    assert_eq(store.nodes[16], expected);
    assert_eq(lazy_root(&mut store, 65536), expected);
}

#[test]
fn typehashes_match_their_definitions() {
    let ballot = "Ballot(uint256 e3Id,address slot,bytes32 ciphertextCommitment)".as_bytes();
    assert_eq(BALLOT_TYPEHASH, keccak256(ballot, ballot.len()));
    let availability = "InputAvailability(uint256 e3Id,bytes32 inputId,uint64 expiresAt)".as_bytes();
    assert_eq(INPUT_AVAILABILITY_TYPEHASH, keccak256(availability, availability.len()));
}

global L1_PROGRAM: EthAddress = EthAddress::from_field(0x1111111111111111111111111111111111111111);
global SLOT: Field = 0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266;
global ROUND_ID: Field = 7;
// `Interfold.request` numbers E3s from `uint160(interfold) << 96`: a 256-bit value that does not fit a field.
global INTERFOLD: EthAddress = EthAddress::from_field(0xdfa59d66c173a00643ebe80e172af5a8cf244b30);
global E3_ID: [u8; 32] = [
    0xdf, 0xa5, 0x9d, 0x66, 0xc1, 0x73, 0xa0, 0x06, 0x43, 0xeb, 0xe8, 0x0e, 0x17, 0x2a, 0xf5, 0xa8,
    0xcf, 0x24, 0x4b, 0x30, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x07,
];
global CT_COMMITMENT: Field = 0x0fa7a80cec2504d63d25b556b08413a79ebd4747901c9c5ba2ab7a122a4d3e8d;
global DOMAIN_SEPARATOR: [u8; 32] = [
    0x3a, 0x9f, 0xfd, 0xc0, 0x8a, 0xb1, 0xb1, 0x9a, 0xbe, 0x9a, 0x1e, 0xb7, 0xc6, 0xcb, 0x52, 0xbc,
    0x74, 0x5e, 0x8d, 0x17, 0x63, 0xd0, 0xed, 0x9a, 0x7c, 0xc6, 0x5b, 0x06, 0x0f, 0x2a, 0x1e, 0x8b,
];
global BALLOT_DIGEST: [u8; 32] = [
    0xc4, 0x61, 0x36, 0x52, 0x53, 0xa1, 0x48, 0x0b, 0xc3, 0x1c, 0x1d, 0xbf, 0x73, 0x5e, 0x46, 0xcc,
    0xb6, 0x98, 0x20, 0x80, 0x87, 0xc4, 0x40, 0x57, 0xd9, 0x4f, 0x92, 0x9b, 0x19, 0xf3, 0xf7, 0x54,
];
global VOTE_HASH: [u8; 32] = [
    0xf3, 0xaf, 0x1c, 0x48, 0x39, 0x86, 0x55, 0xd5, 0x5c, 0x0a, 0x49, 0x5c, 0x43, 0x55, 0xd9, 0x3f,
    0xda, 0x58, 0x7f, 0x67, 0xcc, 0x59, 0xb6, 0x18, 0xc3, 0xa2, 0xa0, 0xb7, 0x17, 0xf4, 0x9e, 0x2b,
];
global INPUT_ID: [u8; 32] = [
    0xaf, 0x4e, 0x2a, 0x45, 0x2f, 0x70, 0x38, 0x1b, 0xaf, 0x91, 0x0f, 0x34, 0xed, 0xf7, 0xb5, 0xd7,
    0x86, 0x82, 0xfd, 0x71, 0x51, 0x57, 0xb5, 0x3d, 0x74, 0x84, 0xe3, 0x19, 0xab, 0x79, 0xa9, 0xea,
];
global AVAILABILITY_DIGEST: [u8; 32] = [
    0x3b, 0x81, 0x24, 0xaf, 0xe8, 0x7f, 0xeb, 0x70, 0x0e, 0x2c, 0x89, 0x69, 0x9d, 0x09, 0x06, 0x67,
    0xca, 0x46, 0xfc, 0x07, 0x93, 0x65, 0x70, 0xc8, 0x2b, 0x0e, 0xed, 0x6c, 0x09, 0x67, 0xdd, 0xc5,
];
global SIGNER_X: [u8; 32] = [
    0x83, 0x18, 0x53, 0x5b, 0x54, 0x10, 0x5d, 0x4a, 0x7a, 0xae, 0x60, 0xc0, 0x8f, 0xc4, 0x5f, 0x96,
    0x87, 0x18, 0x1b, 0x4f, 0xdf, 0xc6, 0x25, 0xbd, 0x1a, 0x75, 0x3f, 0xa7, 0x39, 0x7f, 0xed, 0x75,
];
global SIGNER_Y: [u8; 32] = [
    0x35, 0x47, 0xf1, 0x1c, 0xa8, 0x69, 0x66, 0x46, 0xf2, 0xf3, 0xac, 0xb0, 0x8e, 0x31, 0x01, 0x6a,
    0xfa, 0xc2, 0x3e, 0x63, 0x0c, 0x5d, 0x11, 0xf5, 0x9f, 0x61, 0xfe, 0xf5, 0x7b, 0x0d, 0x2a, 0xa5,
];
global SIGNATURE: [u8; 64] = [
    0xe7, 0x40, 0x4b, 0x74, 0x60, 0x23, 0xab, 0x34, 0x1a, 0xa7, 0x34, 0x30, 0xc5, 0xb8, 0xd9, 0xd1,
    0x5e, 0x6c, 0xd4, 0xff, 0xf4, 0xd5, 0x10, 0x5b, 0x0e, 0x73, 0x08, 0xd4, 0xa4, 0x69, 0xd5, 0x0c,
    0x23, 0xa6, 0x71, 0x23, 0xe9, 0xca, 0x83, 0x80, 0x5e, 0x21, 0xcc, 0x5c, 0x7b, 0xdf, 0x1a, 0x3b,
    0xc4, 0x5a, 0x4b, 0xdc, 0x4d, 0xba, 0x0c, 0x8b, 0xf3, 0x5d, 0xb0, 0xa0, 0x8f, 0x0b, 0xed, 0x5c,
];

#[test]
fn ballot_digest_matches_eip712() {
    assert_eq(ballot_digest(DOMAIN_SEPARATOR, E3_ID, SLOT, CT_COMMITMENT), BALLOT_DIGEST);
}

#[test]
fn input_id_matches_abi_encode() {
    assert_eq(input_id(L1_PROGRAM, E3_ID, VOTE_HASH, CT_COMMITMENT, SLOT, 1), INPUT_ID);
}

#[test]
fn availability_digest_matches_eip712() {
    assert_eq(availability_digest(DOMAIN_SEPARATOR, E3_ID, INPUT_ID, 1700000999), AVAILABILITY_DIGEST);
}

#[test]
fn availability_signature_verifies_against_the_signer_key() {
    assert(std::ecdsa_secp256k1::verify_signature(SIGNER_X, SIGNER_Y, SIGNATURE, AVAILABILITY_DIGEST));
}

#[test(should_fail)]
fn availability_signature_does_not_verify_another_digest() {
    assert(std::ecdsa_secp256k1::verify_signature(SIGNER_X, SIGNER_Y, SIGNATURE, BALLOT_DIGEST));
}

#[test]
fn full_e3_id_is_the_interfold_address_over_the_round_id() {
    assert_eq(full_e3_id(INTERFOLD, ROUND_ID), E3_ID);
    // Above the BN254 modulus (0x3064...), which is why the contract keys rounds by their low 96 bits.
    assert(E3_ID[0] > 0x30);
}

#[test]
fn full_e3_id_takes_the_largest_round_id() {
    let id = full_e3_id(INTERFOLD, 0xffffffffffffffffffffffff);
    assert_eq(id[20], 0xff);
    assert_eq(id[31], 0xff);
}

#[test(should_fail)]
fn full_e3_id_rejects_a_round_id_of_97_bits() {
    let _ = full_e3_id(INTERFOLD, 0x1000000000000000000000000);
}

#[test]
fn halves_round_trip() {
    let halves = to_halves(BALLOT_DIGEST);
    assert_eq(from_halves(halves), BALLOT_DIGEST);
}

#[test]
fn input_leaf_matches_solidity() {
    assert_eq(
        input_leaf(VOTE_HASH, CT_COMMITMENT, SLOT, 1),
        7430538051707153124846057851195951052710017421125496327693903330240367478431,
    );
}

unconstrained fn single_root() -> Field {
    let mut store = MemNodes { nodes: [0; 17] };
    lazy_insert(
        &mut store,
        0,
        input_leaf([
            0xa6, 0x58, 0xb4, 0xe7, 0x3e, 0xd7, 0x55, 0x5b, 0xf1, 0xf2, 0x23, 0xab, 0xcc, 0x58, 0x0c, 0x0f,
            0xa6, 0x26, 0xd6, 0x9e, 0x60, 0x4a, 0x23, 0xe4, 0x16, 0x63, 0xf4, 0x48, 0x86, 0x52, 0x12, 0x8b,
        ], 0x0fa7a80cec2504d63d25b556b08413a79ebd4747901c9c5ba2ab7a122a4d3e8d, 0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266, 0),
    );
    lazy_root(&mut store, 1)
}

#[test]
unconstrained fn single_input_root_matches_crisp_program() {
    assert_eq(single_root(), 0x2546f6380fb62396a0c4e59629add7836cba61676e3dd5786e952b9ffbb31993);
}

unconstrained fn append_root() -> Field {
    let mut store = MemNodes { nodes: [0; 17] };
    lazy_insert(
        &mut store,
        0,
        input_leaf([
            0x8b, 0xd7, 0x47, 0x9f, 0xe0, 0x4e, 0x26, 0xd8, 0xc2, 0xc7, 0xd8, 0xbc, 0xbb, 0x32, 0x0b, 0xfd,
            0xe8, 0x45, 0x53, 0x8c, 0x88, 0xe2, 0x75, 0x80, 0x36, 0x10, 0x81, 0x92, 0x1c, 0x8e, 0x91, 0x77,
        ], 0x1ef408bd04bc929ce765788f3762c813bf30b4edb80e9c6fdcfd9b5efe156da3, 0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266, 0),
    );
    lazy_insert(
        &mut store,
        1,
        input_leaf([
            0xd4, 0xfd, 0x4e, 0x18, 0x91, 0x32, 0x27, 0x30, 0x36, 0x44, 0x9f, 0xc9, 0xe1, 0x11, 0x98, 0xc7,
            0x39, 0x16, 0x1b, 0x4c, 0x01, 0x16, 0xa9, 0xa2, 0xdc, 0xcd, 0xfa, 0x1c, 0x49, 0x20, 0x06, 0xf1,
        ], 0x2c90a7ba5d843a28e35816a3725339b325e189fc9b0ee61aaef0c84d8dbc6871, 0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266, 1),
    );
    lazy_insert(
        &mut store,
        2,
        input_leaf([
            0x3e, 0x7f, 0xdb, 0x5c, 0x6f, 0x86, 0x00, 0xaf, 0xbc, 0x91, 0x15, 0x63, 0x12, 0x5b, 0x78, 0x7b,
            0xe0, 0x8a, 0xb5, 0xba, 0x07, 0xca, 0x7b, 0x1f, 0x9f, 0x64, 0x94, 0xb9, 0x13, 0x08, 0xac, 0xcd,
        ], 0x0cd50a08c6cc1c40b8b21119dd865b5e3ed6901580cfae64ed22d6faf1e9a2ab, 0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266, 1),
    );
    lazy_root(&mut store, 3)
}

#[test]
unconstrained fn append_input_root_matches_crisp_program() {
    assert_eq(append_root(), 0x2f2f4b27cde4669979d0dd2a5977e2a46f03c7be031afb4911ef5272e7302e70);
}

unconstrained fn revote_root() -> Field {
    let mut store = MemNodes { nodes: [0; 17] };
    lazy_insert(
        &mut store,
        0,
        input_leaf([
            0xa6, 0x58, 0xb4, 0xe7, 0x3e, 0xd7, 0x55, 0x5b, 0xf1, 0xf2, 0x23, 0xab, 0xcc, 0x58, 0x0c, 0x0f,
            0xa6, 0x26, 0xd6, 0x9e, 0x60, 0x4a, 0x23, 0xe4, 0x16, 0x63, 0xf4, 0x48, 0x86, 0x52, 0x12, 0x8b,
        ], 0x0fa7a80cec2504d63d25b556b08413a79ebd4747901c9c5ba2ab7a122a4d3e8d, 0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266, 0),
    );
    lazy_insert(
        &mut store,
        1,
        input_leaf([
            0x23, 0xf9, 0x87, 0x63, 0x7d, 0x84, 0x94, 0xee, 0x48, 0x12, 0x1d, 0x0d, 0xd1, 0x23, 0xe9, 0x61,
            0x42, 0xc9, 0x42, 0x82, 0xe5, 0x48, 0x06, 0x29, 0x87, 0x27, 0x69, 0xf8, 0x09, 0x1c, 0xe3, 0xe0,
        ], 0x0b996e342bbf1a307a887c1eb8cec07d8177556e6f5697fc58e5f50b3cc97071, 0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266, 1),
    );
    lazy_root(&mut store, 2)
}

#[test]
unconstrained fn revote_input_root_matches_crisp_program() {
    assert_eq(revote_root(), 0x1f05912e7d833e66d73eee77bf99ed1794762256feac2f743fe5d2abdce69427);
}

#[test]
fn single_input_leaf_matches_crisp_program() {
    let e = [
    0xa6, 0x58, 0xb4, 0xe7, 0x3e, 0xd7, 0x55, 0x5b, 0xf1, 0xf2, 0x23, 0xab, 0xcc, 0x58, 0x0c, 0x0f,
    0xa6, 0x26, 0xd6, 0x9e, 0x60, 0x4a, 0x23, 0xe4, 0x16, 0x63, 0xf4, 0x48, 0x86, 0x52, 0x12, 0x8b,
];
    assert_eq(
        input_leaf(e, 0x0fa7a80cec2504d63d25b556b08413a79ebd4747901c9c5ba2ab7a122a4d3e8d, 0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266, 0),
        17064579973443254311234889176086192835542985516841742181351750524622033211187,
    );
}

// Contents of the L1 messages, from extensions/aztec/l1/tests/fixtures/message-vectors.json.
#[test]
fn round_content_matches_l1() {
    // `round` of the vectors: a round with a nationality-inclusion rule.
    let scope_hash = 250599715960339284498530861402620333660067521173639798116098273223811287878;
    assert_eq(
        round_content(
            ROUND_ID,
            3,
            100,
            1700000000,
            1700003600,
            65536,
            scope_hash,
            18,
            true,
            1,
            5081652588602725151884571709550774784856152446387414599336402627759404397508,
        ),
        165617436206551639097302237866014059415613311973275787117770305345374998780,
    );
}

#[test]
fn round_content_without_a_nationality_rule_matches_l1() {
    // `roundNoRule` of the vectors: no nationality rule, commitment 0.
    let scope_hash = 250599715960339284498530861402620333660067521173639798116098273223811287878;
    assert_eq(
        round_content(ROUND_ID, 3, 100, 1700000000, 1700003600, 65536, scope_hash, 18, true, 0, 0),
        114747917202780534056629942236279368479291946155553415707235899133399286720,
    );
}

#[test]
fn key_content_matches_l1() {
    assert_eq(
        key_content(ROUND_ID, 0x0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20),
        217569609759503501446489404904122803263470894805337801419578826484203739423,
    );
}

#[test]
fn root_content_matches_l1() {
    assert_eq(
        root_content(ROUND_ID, 0x2098f5fb9e239eab3ceac3f27b81e481dc3124d55ffed523a839ee8446b64864, 5),
        233142214502386324391626825260934725087197459652887864602806282982013087448,
    );
}

// The base proofs of one real ballot (`insecure-64`, a first vote of [10, 0, 0] by the SDK test address), made by
// `generateBaseProofs`. `FOLD_PK_COMMITMENT` is the last public input of the fold proof of the same inputs, and
// `CRISP_CT_COMMITMENT` the ninth of the crisp proof: what the `user_data_encryption` circuit computed from the same
// ct0 / ct1 / pk public inputs, which `ballot.nr` recomputes.
global CT0_INPUTS: [Field; 4] = [
    0x0a8e57038582d49c9a8480fdfa6fb47a373f25d12dffaca2e9ff8276871c772a,
    0x05e8a490346c66de997174c41f96d60c41db9d4f075c285a9b3bb4a2efd706a6,
    0x2480818a61756c2a9022473471281d77b54a894bd0b50af0bb1586e797bd6654,
    0x247f53f7bc7a8ffe216bcc938f7f4bf2950c5d53b15a731fe7d8148f8458c1f1,
];
global CT1_INPUTS: [Field; 3] = [
    0x1c13635babefcf5bc4c7dd64d8bf715460e1b45be0071f62664b525f3ff8eeda,
    0x27c72312acdb991d858c89daddf092c12dd18b218add90767d664de079b3fe01,
    0x247f53f7bc7a8ffe216bcc938f7f4bf2950c5d53b15a731fe7d8148f8458c1f1,
];
global FOLD_PK_COMMITMENT: Field = 0x0d13e9ea621560435aa5c76febdb456982c5b714ba0043d10939f2166bbb509f;
global CRISP_CT_COMMITMENT: Field = 0x28038614f51913942602348e52269ad926d400835cb73c8a3679d7b3d1eed070;

#[test]
fn pk_commitment_matches_the_user_data_encryption_circuit() {
    assert_eq(pk_commitment(CT0_INPUTS, CT1_INPUTS), FOLD_PK_COMMITMENT);
}

#[test]
fn ciphertext_commitment_matches_the_user_data_encryption_circuit() {
    assert_eq(ciphertext_commitment(CT0_INPUTS, CT1_INPUTS), CRISP_CT_COMMITMENT);
}

#[test]
fn crisp_public_inputs_link_the_encryption_proofs() {
    let values = [0, 1, 2, 3, 4, 1, 3, CRISP_CT_COMMITMENT];
    let inputs = crisp_public_inputs(CT0_INPUTS, CT1_INPUTS, FOLD_PK_COMMITMENT, values);
    for i in 0..8 {
        assert_eq(inputs[i], values[i]);
    }
    // The ciphertext commitment and the k1 commitment come from the encryption proofs, not from the caller.
    assert_eq(inputs[8], CRISP_CT_COMMITMENT);
    assert_eq(inputs[9], CT0_INPUTS[2]);
}

#[test(should_fail_with = "ct0 and ct1 commit to different u")]
fn crisp_public_inputs_need_the_same_u() {
    let mut ct1 = CT1_INPUTS;
    ct1[2] += 1;
    let _ = crisp_public_inputs(CT0_INPUTS, ct1, FOLD_PK_COMMITMENT, [0; 8]);
}

#[test(should_fail_with = "ballot is encrypted to another committee key")]
fn crisp_public_inputs_need_the_committee_key() {
    let _ = crisp_public_inputs(CT0_INPUTS, CT1_INPUTS, FOLD_PK_COMMITMENT + 1, [0; 8]);
}

#[test]
fn a_changed_ciphertext_half_changes_the_ciphertext_commitment() {
    // Whichever half is swapped for another proof's, crisp's `ct_commitment` input changes, so its proof stops verifying.
    let base = ciphertext_commitment(CT0_INPUTS, CT1_INPUTS);
    let mut ct0 = CT0_INPUTS;
    ct0[1] += 1;
    assert(ciphertext_commitment(ct0, CT1_INPUTS) != base);
    let mut ct1 = CT1_INPUTS;
    ct1[1] += 1;
    assert(ciphertext_commitment(CT0_INPUTS, ct1) != base);
    // And the halves are not interchangeable.
    let swapped = ciphertext_commitment([0, CT1_INPUTS[1], 0, 0], [0, CT0_INPUTS[1], 0]);
    assert(swapped != base);
}
