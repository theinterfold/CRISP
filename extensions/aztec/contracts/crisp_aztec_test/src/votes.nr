// TXE tests of `CrispAztecVotes`. As for `CrispAztec`, TXE does not run proof verification, so `cast` is exercised
// with zero proofs and the real verification keys of `base_fixture.nr`.
//
// The message contents are `sha256ToField(abi.encode(...))` of `CRISPAztecVotesMessages.round` / `.enroll`, computed
// here from the same word layout (sha256 of the words, first 31 bytes as the field).

use crate::base_fixture::{CRISP_VK, CRISP_VK_HASH, CT0_VK, CT0_VK_HASH, CT1_VK, CT1_VK_HASH};
use crate::vectors::{
    APPEND_INPUT_ROOT, DOMAIN_SEPARATOR, FIRST_BALLOT, REVOTE, SECOND_REVOTE, SIGNER_X, SIGNER_Y, SLOT_1, SLOT_2,
    SLOT_3,
};
use aztec::{
    protocol::{address::{AztecAddress, EthAddress}, traits::FromField},
    test::helpers::test_environment::TestEnvironment,
};
use crisp_aztec_lib::{
    ballot::{pk_commitment, CT0_PUBLIC_INPUTS, CT1_PUBLIC_INPUTS},
    hashing::{full_e3_id, key_content},
    types::InputEntry,
};
use crisp_aztec_votes::{CrispAztecVotes, messages::{enroll_content, round_content}, types::{Config, RoundConfig}};
use crisp_aztec_votes::staging::{staging_commitment, staging_key_digest, staging_secret};
use poseidon::poseidon::bn254::hash_2;

global ROUND_ID: Field = 7;
global NUM_OPTIONS: Field = 3;
global L1_PROGRAM: EthAddress = EthAddress::from_field(0x1111111111111111111111111111111111111111);
global INTERFOLD: EthAddress = EthAddress::from_field(0xdfa59d66c173a00643ebe80e172af5a8cf244b30);
// After the TXE clock (it starts at the wall-clock time) and before the vectors' attestation expiry (2527200000).
global T0: u64 = 2000000000;
global INPUT_START: u64 = T0 + 100;
global INPUT_END: u64 = T0 + 10000;
global LIMIT: u32 = 65536;
global WEIGHT_1: Field = 1234;
global WEIGHT_2: Field = 77;
// Round bookkeeping and enrollment are permissionless, so any address may send them.
global KEEPER: AztecAddress = AztecAddress::from_field(0xbee);

unconstrained fn deploy() -> (TestEnvironment, AztecAddress) {
    let mut env = TestEnvironment::new();
    let deployer = env.create_light_account();
    let votes = env.deploy("@crisp_aztec_votes/CrispAztecVotes").with_public_initializer(
        deployer,
        CrispAztecVotes::interface().constructor(
            L1_PROGRAM,
            INTERFOLD,
            DOMAIN_SEPARATOR,
            DOMAIN_SEPARATOR,
            SIGNER_X,
            SIGNER_Y,
            CT0_VK_HASH,
            CT1_VK_HASH,
            CRISP_VK_HASH,
        ),
    );
    env.mine_block_at(T0);
    (env, votes)
}

unconstrained fn open_round(env: TestEnvironment, votes: AztecAddress) {
    let leaf_index = env.send_l1_to_l2_message(
        round_content(ROUND_ID, NUM_OPTIONS, INPUT_START, INPUT_END, LIMIT),
        0,
        L1_PROGRAM,
        votes,
    );
    let keeper = KEEPER;
    let _ = env.call_public(
        keeper,
        CrispAztecVotes::at(votes).open_round(ROUND_ID, NUM_OPTIONS, INPUT_START, INPUT_END, LIMIT, leaf_index),
    );
}

fn ct0_inputs() -> [Field; CT0_PUBLIC_INPUTS] {
    [0x1001, 0x1002, 0x1003, 0x1004]
}

fn ct1_inputs() -> [Field; CT1_PUBLIC_INPUTS] {
    [0x2001, 0x2002, 0x1004]
}

unconstrained fn publish_key(env: TestEnvironment, votes: AztecAddress) {
    let key = pk_commitment(ct0_inputs(), ct1_inputs());
    let leaf_index = env.send_l1_to_l2_message(key_content(ROUND_ID, key), 0, L1_PROGRAM, votes);
    let keeper = KEEPER;
    let _ = env.call_public(keeper, CrispAztecVotes::at(votes).publish_key(ROUND_ID, key, leaf_index));
}

/// Sends the ENROLL message of `(slot, weight)` and consumes it from `KEEPER`.
unconstrained fn enroll(env: TestEnvironment, votes: AztecAddress, slot: Field, weight: Field) {
    let leaf_index = env.send_l1_to_l2_message(enroll_content(ROUND_ID, slot, weight), 0, L1_PROGRAM, votes);
    let keeper = KEEPER;
    let _ = env.call_public(keeper, CrispAztecVotes::at(votes).enroll(ROUND_ID, slot, weight, leaf_index));
}

unconstrained fn open() -> (TestEnvironment, AztecAddress) {
    let (env, votes) = deploy();
    open_round(env, votes);
    (env, votes)
}

// ---------------------------------------------------------------------------------------------------------------------
// Message contents
// ---------------------------------------------------------------------------------------------------------------------

#[test]
fn round_content_matches_the_l1_layout() {
    // sha256(abi.encode(1, 7, 3, 1700000000, 1700003600, 65536)), first 31 bytes.
    assert_eq(
        round_content(ROUND_ID, 3, 1700000000, 1700003600, 65536),
        66306622999276458050712774278135458868111129163067623109176412886686293870,
    );
}

#[test]
fn enroll_content_matches_the_l1_layout() {
    // sha256(abi.encode(4, 7, uint256(uint160(SLOT_1)), 1234)), first 31 bytes.
    assert_eq(
        enroll_content(ROUND_ID, SLOT_1, 1234),
        179876850444324325927497245117676319881291298513108156744022087147525662795,
    );
}

// ---------------------------------------------------------------------------------------------------------------------
// Deployment and rounds
// ---------------------------------------------------------------------------------------------------------------------

#[test]
unconstrained fn constructor_stores_the_configuration() {
    let (env, votes) = deploy();
    let config: Config = env.execute_utility(CrispAztecVotes::at(votes).get_config());
    assert_eq(config.l1_program, L1_PROGRAM);
    assert_eq(config.interfold, INTERFOLD);
    assert_eq(config.ct0_vk_hash, CT0_VK_HASH);
    assert_eq(config.ct1_vk_hash, CT1_VK_HASH);
    assert_eq(config.crisp_vk_hash, CRISP_VK_HASH);
}

#[test]
unconstrained fn open_round_consumes_the_round_message() {
    let (env, votes) = open();
    let round: RoundConfig = env.execute_utility(CrispAztecVotes::at(votes).get_round(ROUND_ID));
    assert_eq(round.num_options, NUM_OPTIONS);
    assert_eq(round.input_start, INPUT_START);
    assert_eq(round.input_end, INPUT_END);
    assert_eq(round.input_limit, LIMIT);
}

#[test(should_fail)]
unconstrained fn open_round_rejects_arguments_the_message_does_not_carry() {
    let (env, votes) = deploy();
    let leaf_index = env.send_l1_to_l2_message(
        round_content(ROUND_ID, NUM_OPTIONS, INPUT_START, INPUT_END, LIMIT),
        0,
        L1_PROGRAM,
        votes,
    );
    let keeper = KEEPER;
    let _ = env.call_public(
        keeper,
        CrispAztecVotes::at(votes).open_round(ROUND_ID, NUM_OPTIONS + 1, INPUT_START, INPUT_END, LIMIT, leaf_index),
    );
}

#[test(should_fail)]
unconstrained fn a_round_cannot_be_opened_twice() {
    let (env, votes) = open();
    open_round(env, votes);
}

#[test(should_fail_with = "empty input window")]
unconstrained fn open_round_rejects_an_empty_window() {
    let (env, votes) = deploy();
    let keeper = KEEPER;
    let _ = env.call_public(
        keeper,
        CrispAztecVotes::at(votes).open_round(ROUND_ID, NUM_OPTIONS, INPUT_END, INPUT_END, LIMIT, 0),
    );
}

#[test(should_fail_with = "input limit out of range")]
unconstrained fn open_round_rejects_a_limit_above_the_tree_capacity() {
    let (env, votes) = deploy();
    let keeper = KEEPER;
    let _ = env.call_public(
        keeper,
        CrispAztecVotes::at(votes).open_round(ROUND_ID, NUM_OPTIONS, INPUT_START, INPUT_END, LIMIT + 1, 0),
    );
}

#[test]
unconstrained fn publish_key_stores_the_committee_key() {
    let (env, votes) = open();
    publish_key(env, votes);
    let key: Field = env.execute_utility(CrispAztecVotes::at(votes).get_committee_key(ROUND_ID));
    assert_eq(key, pk_commitment(ct0_inputs(), ct1_inputs()));
}

// ---------------------------------------------------------------------------------------------------------------------
// Enrollment
// ---------------------------------------------------------------------------------------------------------------------

#[test]
unconstrained fn enroll_inserts_the_slot_and_weight_leaf() {
    let (env, votes) = open();
    enroll(env, votes, SLOT_1, WEIGHT_1);

    let leaf = hash_2([SLOT_1, WEIGHT_1]);
    // A one-leaf LeanIMT's root is the leaf.
    assert_eq(env.execute_utility(CrispAztecVotes::at(votes).get_census_root(ROUND_ID)), leaf);
    assert_eq(env.execute_utility(CrispAztecVotes::at(votes).get_census_count(ROUND_ID)), 1);
    assert(env.execute_utility(CrispAztecVotes::at(votes).is_census_root_known(ROUND_ID, leaf)));
    assert(env.execute_utility(CrispAztecVotes::at(votes).is_slot_enrolled(ROUND_ID, SLOT_1)));
    assert(!env.execute_utility(CrispAztecVotes::at(votes).is_slot_enrolled(ROUND_ID, SLOT_2)));
}

#[test]
unconstrained fn every_enrollment_adds_a_root_and_past_roots_stay_known() {
    let (env, votes) = open();
    enroll(env, votes, SLOT_1, WEIGHT_1);
    enroll(env, votes, SLOT_2, WEIGHT_2);

    let leaf_1 = hash_2([SLOT_1, WEIGHT_1]);
    let root = hash_2([leaf_1, hash_2([SLOT_2, WEIGHT_2])]);
    assert_eq(env.execute_utility(CrispAztecVotes::at(votes).get_census_root(ROUND_ID)), root);
    assert(env.execute_utility(CrispAztecVotes::at(votes).is_census_root_known(ROUND_ID, root)));
    assert(env.execute_utility(CrispAztecVotes::at(votes).is_census_root_known(ROUND_ID, leaf_1)));
    assert(!env.execute_utility(CrispAztecVotes::at(votes).is_census_root_known(ROUND_ID, root + 1)));
}

#[test(should_fail_with = "slot already enrolled")]
unconstrained fn a_slot_enrolls_once() {
    let (env, votes) = open();
    enroll(env, votes, SLOT_1, WEIGHT_1);
    enroll(env, votes, SLOT_1, WEIGHT_2);
}

#[test(should_fail_with = "zero weight")]
unconstrained fn enroll_rejects_a_zero_weight() {
    let (env, votes) = open();
    enroll(env, votes, SLOT_1, 0);
}

#[test(should_fail_with = "enrollment closed")]
unconstrained fn enrollment_closes_with_the_input_window() {
    let (env, votes) = open();
    env.mine_block_at(INPUT_END);
    enroll(env, votes, SLOT_1, WEIGHT_1);
}

#[test(should_fail)]
unconstrained fn enrollment_needs_an_open_round() {
    let (env, votes) = deploy();
    enroll(env, votes, SLOT_1, WEIGHT_1);
}

#[test(should_fail)]
unconstrained fn enroll_rejects_a_weight_the_message_does_not_carry() {
    let (env, votes) = open();
    let leaf_index = env.send_l1_to_l2_message(enroll_content(ROUND_ID, SLOT_1, WEIGHT_1), 0, L1_PROGRAM, votes);
    let keeper = KEEPER;
    let _ = env.call_public(keeper, CrispAztecVotes::at(votes).enroll(ROUND_ID, SLOT_1, WEIGHT_1 + 1, leaf_index));
}

#[test(should_fail)]
unconstrained fn enroll_rejects_a_message_from_another_sender() {
    let (env, votes) = open();
    let other = EthAddress::from_field(0x2222222222222222222222222222222222222222);
    let leaf_index = env.send_l1_to_l2_message(enroll_content(ROUND_ID, SLOT_1, WEIGHT_1), 0, other, votes);
    let keeper = KEEPER;
    let _ = env.call_public(keeper, CrispAztecVotes::at(votes).enroll(ROUND_ID, SLOT_1, WEIGHT_1, leaf_index));
}

// ---------------------------------------------------------------------------------------------------------------------
// Ballots and closing
// ---------------------------------------------------------------------------------------------------------------------

/// An open round with a committee key and `SLOT_1`, `SLOT_2` enrolled, the input window open. Returns the voter and the
/// census root the enrollments produced.
unconstrained fn open_for_casting() -> (TestEnvironment, AztecAddress, AztecAddress, Field) {
    let (mut env, votes) = open();
    publish_key(env, votes);
    enroll(env, votes, SLOT_1, WEIGHT_1);
    enroll(env, votes, SLOT_2, WEIGHT_2);
    let voter = env.create_light_account();
    env.mine_block_at(INPUT_START);
    let census_root = hash_2([hash_2([SLOT_1, WEIGHT_1]), hash_2([SLOT_2, WEIGHT_2])]);
    (env, votes, voter, census_root)
}

unconstrained fn cast(
    env: TestEnvironment,
    votes: AztecAddress,
    from: AztecAddress,
    c: crate::vectors::Cast,
    census_root: Field,
) {
    env.call_private(
        from,
        CrispAztecVotes::at(votes).cast(
            ROUND_ID,
            CT0_VK,
            [0; 410],
            ct0_inputs(),
            CT1_VK,
            [0; 410],
            ct1_inputs(),
            CRISP_VK,
            [0; 410],
            c.slot,
            c.ct_commitment,
            c.encrypted_vote_hash,
            c.parent_index_plus_one,
            c.prev_commitment,
            census_root,
            c.expires_at,
            c.signature,
        ),
    );
}

#[test]
unconstrained fn cast_accepts_a_census_root_produced_by_enroll() {
    let (env, votes, voter, census_root) = open_for_casting();
    cast(env, votes, voter, FIRST_BALLOT, census_root);
    cast(env, votes, voter, REVOTE, hash_2([SLOT_1, WEIGHT_1]));
    cast(env, votes, voter, SECOND_REVOTE, census_root);

    assert_eq(env.execute_utility(CrispAztecVotes::at(votes).get_input_count(ROUND_ID)), 3);
    let entry: InputEntry = env.execute_utility(CrispAztecVotes::at(votes).get_input(ROUND_ID, 1));
    assert_eq(entry.slot, SLOT_1);
    assert_eq(entry.commitment, REVOTE.ct_commitment);

    // The same three inputs give the input root the real CRISPProgram produced; closing is the shared one.
    env.mine_block_at(INPUT_END);
    let root = env.call_public(voter, CrispAztecVotes::at(votes).close_round(ROUND_ID));
    assert_eq(root, APPEND_INPUT_ROOT);
    assert(env.execute_utility(CrispAztecVotes::at(votes).is_closed(ROUND_ID)));
}

#[test(should_fail_with = "unknown census root")]
unconstrained fn cast_rejects_a_census_root_enroll_never_produced() {
    let (env, votes, voter, census_root) = open_for_casting();
    cast(env, votes, voter, FIRST_BALLOT, census_root + 1);
}

#[test(should_fail_with = "unknown census root")]
unconstrained fn cast_rejects_a_root_before_the_slots_enrolled() {
    let (mut env, votes) = open();
    publish_key(env, votes);
    let voter = env.create_light_account();
    env.mine_block_at(INPUT_START);
    cast(env, votes, voter, FIRST_BALLOT, hash_2([SLOT_3, WEIGHT_1]));
}

#[test(should_fail_with = "input window still open")]
unconstrained fn close_round_waits_for_the_window() {
    let (env, votes, voter, _) = open_for_casting();
    let _ = env.call_public(voter, CrispAztecVotes::at(votes).close_round(ROUND_ID));
}

#[test(should_fail_with = "round already closed")]
unconstrained fn a_round_closes_once() {
    let (env, votes, voter, _) = open_for_casting();
    env.mine_block_at(INPUT_END);
    let _ = env.call_public(voter, CrispAztecVotes::at(votes).close_round(ROUND_ID));
    let _ = env.call_public(voter, CrispAztecVotes::at(votes).close_round(ROUND_ID));
}

// ---------------------------------------------------------------------------------------------------------------------
// Staging keys
// ---------------------------------------------------------------------------------------------------------------------

// `StagingKey(uint256 e3Id)` of round 7 of INTERFOLD in the test domain, hashed with EIP-712 (keccak256 of
// 0x1901 || domain || keccak256(typehash || e3Id)), and signatures of it by anvil account 0 (the owner of SLOT_1; the
// four differ in their nonce, all valid) and by anvil account 1.
global STAGING_DIGEST: [u8; 32] = [
    0x9d, 0xb0, 0x94, 0x5d, 0xbe, 0x99, 0x38, 0x5a, 0xf8, 0x8e, 0x19, 0xb9, 0xfd, 0x2e, 0xa2, 0x1e,
    0xba, 0x45, 0x3b, 0xe5, 0x6d, 0x88, 0xee, 0x9d, 0x68, 0x5c, 0x2f, 0xe3, 0x84, 0x52, 0x7c, 0xaf,
];
global SIG_0: [u8; 64] = [
    0xfd, 0x19, 0x48, 0x90, 0x79, 0x1e, 0xe6, 0xbd, 0xa5, 0x31, 0x95, 0x3a, 0x98, 0xdc, 0xf2, 0x0c,
    0x67, 0x7f, 0xdf, 0x9f, 0x54, 0x49, 0x2c, 0x19, 0x8f, 0x0e, 0x39, 0x7d, 0x3d, 0x45, 0x4b, 0x0c,
    0x72, 0x9b, 0xcf, 0x45, 0x0f, 0x0a, 0x12, 0xf1, 0x2a, 0x03, 0xf6, 0x3c, 0x50, 0xb3, 0x9d, 0xb5,
    0x51, 0x38, 0xd7, 0xdf, 0x8e, 0x3a, 0x7c, 0x49, 0x9f, 0x8a, 0x1d, 0xe1, 0xb7, 0x88, 0x6f, 0x5e,
];
global SIG_1: [u8; 64] = [
    0x18, 0x03, 0x9d, 0xcf, 0xd7, 0x06, 0x0f, 0x40, 0x38, 0x48, 0xac, 0x8c, 0x9d, 0x64, 0xdf, 0x0d,
    0x93, 0xea, 0x91, 0x62, 0x67, 0xb1, 0x07, 0x0a, 0x67, 0x2e, 0x65, 0x48, 0x6b, 0x3c, 0x97, 0xb5,
    0x52, 0x7e, 0x93, 0x13, 0x5a, 0x55, 0xde, 0xfc, 0x36, 0x18, 0xd1, 0x29, 0x22, 0xeb, 0x9c, 0x58,
    0x0b, 0x62, 0x0a, 0x69, 0xec, 0x16, 0xa3, 0xde, 0x2c, 0x92, 0x0e, 0x12, 0x42, 0x42, 0x53, 0x0a,
];
global SIG_2: [u8; 64] = [
    0xde, 0x0e, 0x72, 0x11, 0x0e, 0x89, 0x37, 0xe3, 0x6d, 0x71, 0xf3, 0x9c, 0xa8, 0xf7, 0xe5, 0x5c,
    0x7b, 0xef, 0x1d, 0x8a, 0x0c, 0x86, 0x80, 0x14, 0xd0, 0xe5, 0xb8, 0x86, 0xd6, 0x7b, 0x4f, 0xa2,
    0x0a, 0xd1, 0x66, 0xe9, 0xbc, 0xe7, 0x0b, 0x7e, 0x1b, 0xc4, 0x96, 0x8c, 0x68, 0xf0, 0x9c, 0x04,
    0x58, 0x54, 0x89, 0x1b, 0x0f, 0x82, 0x7a, 0xe9, 0x22, 0x54, 0x43, 0xdf, 0xee, 0x66, 0x4c, 0x9f,
];
global SIG_3: [u8; 64] = [
    0x9e, 0x8b, 0x4b, 0x3c, 0xb0, 0x23, 0xfb, 0x7b, 0x72, 0x18, 0xf9, 0x26, 0xd9, 0x03, 0xec, 0xc0,
    0xd9, 0x55, 0xb7, 0x91, 0x47, 0x66, 0x61, 0x15, 0x61, 0x99, 0x6d, 0x8e, 0x15, 0xe8, 0x33, 0x1b,
    0x11, 0xc0, 0x79, 0xde, 0xc1, 0x02, 0x09, 0x29, 0x5d, 0x28, 0x49, 0xd5, 0x83, 0xee, 0xe6, 0x82,
    0x40, 0xa1, 0x62, 0x0a, 0x5e, 0x8a, 0xb1, 0x0b, 0xc5, 0x42, 0xb1, 0xb4, 0xcd, 0xc7, 0x77, 0x86,
];
global WRONG_SIGNER_SIG: [u8; 64] = [
    0x94, 0xff, 0x5c, 0xaa, 0x92, 0x3e, 0xe3, 0xa2, 0x40, 0x6b, 0xa0, 0x81, 0x32, 0x77, 0x5d, 0xf4,
    0x45, 0xeb, 0x8e, 0x65, 0x0b, 0xd0, 0xa4, 0xb2, 0x21, 0xa2, 0x55, 0x3c, 0xac, 0x4c, 0x0b, 0x22,
    0x7c, 0x16, 0x10, 0xfd, 0xa9, 0xa1, 0x1a, 0x08, 0xf2, 0x0a, 0x20, 0x7b, 0x56, 0x53, 0x11, 0x26,
    0xa7, 0xb3, 0xb4, 0xca, 0x43, 0x96, 0xf6, 0x48, 0xb6, 0x42, 0xaa, 0x4a, 0x3d, 0xe3, 0x04, 0x19,
];

unconstrained fn bind_with(
    env: TestEnvironment,
    votes: AztecAddress,
    from: AztecAddress,
    slot: Field,
    signature: [u8; 64],
) {
    env.call_private(
        from,
        CrispAztecVotes::at(votes).bind_staging_key(ROUND_ID, slot, SIGNER_X, SIGNER_Y, signature),
    );
}

unconstrained fn bind(env: TestEnvironment, votes: AztecAddress, from: AztecAddress, signature: [u8; 64]) {
    bind_with(env, votes, from, SLOT_1, signature);
}

fn commitment_of(signature: [u8; 64]) -> Field {
    staging_commitment(staging_secret(signature), ROUND_ID)
}

#[test]
fn the_staging_key_digest_is_the_eip712_digest() {
    assert_eq(staging_key_digest(DOMAIN_SEPARATOR, full_e3_id(INTERFOLD, ROUND_ID)), STAGING_DIGEST);
}

#[test]
fn the_staging_secret_and_commitment_match_the_sdk() {
    // r = 0x11..11, s = 0x22..22, round 7.
    let signature = [0x11; 32].concat([0x22; 32]);
    let secret = staging_secret(signature);
    assert_eq(secret, STAGING_SECRET_VECTOR);
    assert_eq(staging_commitment(secret, 7), STAGING_COMMITMENT_VECTOR);
}

#[test]
unconstrained fn bind_staging_key_inserts_the_commitment() {
    let (mut env, votes) = open();
    enroll(env, votes, SLOT_1, WEIGHT_1);
    let voter = env.create_light_account();
    bind(env, votes, voter, SIG_0);

    let commitment = commitment_of(SIG_0);
    // A one-leaf LeanIMT's root is the leaf.
    assert_eq(env.execute_utility(CrispAztecVotes::at(votes).get_staging_root(ROUND_ID)), commitment);
    assert(env.execute_utility(CrispAztecVotes::at(votes).is_staging_root_known(ROUND_ID, commitment)));
    assert_eq(env.execute_utility(CrispAztecVotes::at(votes).get_staging_bind_count(ROUND_ID, SLOT_1)), 1);
    assert_eq(env.execute_utility(CrispAztecVotes::at(votes).get_staging_bind_count(ROUND_ID, SLOT_2)), 0);
}

#[test]
unconstrained fn a_slot_may_bind_three_staging_keys() {
    let (mut env, votes) = open();
    enroll(env, votes, SLOT_1, WEIGHT_1);
    let voter = env.create_light_account();
    bind(env, votes, voter, SIG_0);
    bind(env, votes, voter, SIG_1);
    bind(env, votes, voter, SIG_2);

    let root = hash_2([hash_2([commitment_of(SIG_0), commitment_of(SIG_1)]), commitment_of(SIG_2)]);
    assert_eq(env.execute_utility(CrispAztecVotes::at(votes).get_staging_root(ROUND_ID)), root);
    assert(env.execute_utility(CrispAztecVotes::at(votes).is_staging_root_known(ROUND_ID, commitment_of(SIG_0))));
    assert_eq(env.execute_utility(CrispAztecVotes::at(votes).get_staging_bind_count(ROUND_ID, SLOT_1)), 3);
}

#[test(should_fail_with = "too many staging keys bound")]
unconstrained fn a_fourth_staging_key_is_refused() {
    let (mut env, votes) = open();
    enroll(env, votes, SLOT_1, WEIGHT_1);
    let voter = env.create_light_account();
    bind(env, votes, voter, SIG_0);
    bind(env, votes, voter, SIG_1);
    bind(env, votes, voter, SIG_2);
    bind(env, votes, voter, SIG_3);
}

#[test(should_fail_with = "staging key already bound")]
unconstrained fn a_repeated_commitment_is_refused() {
    let (mut env, votes) = open();
    enroll(env, votes, SLOT_1, WEIGHT_1);
    let voter = env.create_light_account();
    bind(env, votes, voter, SIG_0);
    bind(env, votes, voter, SIG_0);
}

#[test(should_fail_with = "slot not enrolled")]
unconstrained fn bind_staging_key_refuses_an_unenrolled_slot() {
    let (mut env, votes) = open();
    let voter = env.create_light_account();
    bind(env, votes, voter, SIG_0);
}

#[test(should_fail_with = "invalid staging key signature")]
unconstrained fn bind_staging_key_refuses_a_signature_of_another_key() {
    let (mut env, votes) = open();
    enroll(env, votes, SLOT_1, WEIGHT_1);
    let voter = env.create_light_account();
    bind(env, votes, voter, WRONG_SIGNER_SIG);
}

#[test(should_fail_with = "public key is not the slot")]
unconstrained fn bind_staging_key_refuses_a_key_that_is_not_the_slot() {
    let (mut env, votes) = open();
    enroll(env, votes, SLOT_2, WEIGHT_2);
    let voter = env.create_light_account();
    bind_with(env, votes, voter, SLOT_2, SIG_0);
}
global STAGING_SECRET_VECTOR: Field = 0x26f84e2ab5f45f1744f783f14b8ac6b1a2a2f5f63ca0b46e96e5748c6b638848;
global STAGING_COMMITMENT_VECTOR: Field = 0x12dbeab5cedbd4dd2987b522ffaf0718330b4aa49695d2e52a23428e69a0f001;
