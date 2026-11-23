pub mod messages;
pub mod staging;
pub mod types;

use aztec::macros::aztec;

/// CRISP on Aztec with token-weighted voting: the L1 program bridges each slot's weight (`getPastVotes` at the round
/// snapshot, scaled) with an ENROLL message, and anyone may consume it with `enroll`. There is no identity registration.
/// Ballots are proven by the three base circuits exactly as in `CrispAztec`; the contract builds the census tree and the
/// input tree and sends the input root to L1 when the round closes.
#[aztec]
pub contract CrispAztecVotes {
    use crate::{
        messages::{enroll_content, round_content},
        staging::{address_of, staging_commitment, staging_key_digest, staging_secret},
        types::{Config, Counts, RoundConfig, SlotState, MAX_STAGING_BINDS},
    };
    use crisp_aztec_lib::{
        ballot::{crisp_public_inputs, CT0_PUBLIC_INPUTS, CT1_PUBLIC_INPUTS},
        constants::{
            LOG_INPUT_COMMITTED, LOG_KEY_PUBLISHED, LOG_MEMBER_REGISTERED, LOG_ROUND_CLOSED, LOG_ROUND_OPENED,
            LOG_STAGING_KEY_BOUND, MAX_LEAVES,
        },
        hashing::{
            availability_digest, ballot_digest, bytes_to_field, from_halves, full_e3_id, input_id, input_leaf,
            key_content, root_content, to_halves,
        },
        nodes::PublicNodes,
        tree::{ceil_log2, lazy_insert, lazy_root, lean_insert},
        types::InputEntry,
    };
    use aztec::{
        macros::{functions::{external, initializer, only_self}, storage::storage},
        protocol::address::EthAddress,
        state_vars::{Map, PublicImmutable, PublicMutable},
    };
    use bb_proof_verification::{UltraHonkProof, UltraHonkVerificationKey, verify_honk_proof_non_zk};
    use poseidon::{poseidon::bn254::hash_2, poseidon2::Poseidon2};

    #[storage]
    struct Storage<Context> {
        config: PublicImmutable<Config, Context>,
        // Round parameters and committee key, written once each from an L1 message.
        rounds: Map<Field, PublicImmutable<RoundConfig, Context>, Context>,
        committee_keys: Map<Field, PublicImmutable<Field, Context>, Context>,
        closed: Map<Field, PublicMutable<bool, Context>, Context>,
        // Leaf counts of the three trees of a round, kept together.
        counts: Map<Field, PublicMutable<Counts, Context>, Context>,
        // Census tree (LeanIMT): frontier by level (the root is the node at the tree's depth), every
        // root a ballot may have been proven against, and the enrollment state of each slot.
        census_nodes: Map<Field, Map<u32, PublicMutable<Field, Context>, Context>, Context>,
        census_roots: Map<Field, Map<Field, PublicMutable<bool, Context>, Context>, Context>,
        slots: Map<Field, Map<Field, PublicMutable<SlotState, Context>, Context>, Context>,
        // Staging tree (LeanIMT, same layout as the census): the commitments of the staging keys bound so far, every root
        // a staging pass may have been proven against, and the commitments already in it.
        staging_nodes: Map<Field, Map<u32, PublicMutable<Field, Context>, Context>, Context>,
        staging_roots: Map<Field, Map<Field, PublicMutable<bool, Context>, Context>, Context>,
        staging_commitments: Map<Field, Map<Field, PublicMutable<bool, Context>, Context>, Context>,
        // Input tree (LazyIMT): frontier by level, the (slot, commitment) of each input for the parent
        // rule, and the ids of the inputs already committed.
        input_frontier: Map<Field, Map<u32, PublicMutable<Field, Context>, Context>, Context>,
        inputs: Map<Field, Map<u32, PublicMutable<InputEntry, Context>, Context>, Context>,
        input_ids: Map<Field, Map<Field, PublicMutable<bool, Context>, Context>, Context>,
    }

    #[external("public")]
    #[initializer]
    fn constructor(
        l1_program: EthAddress,
        interfold: EthAddress,
        ballot_domain_separator: [u8; 32],
        availability_domain_separator: [u8; 32],
        availability_signer_pubkey_x: [u8; 32],
        availability_signer_pubkey_y: [u8; 32],
        ct0_vk_hash: Field,
        ct1_vk_hash: Field,
        crisp_vk_hash: Field,
    ) {
        self.storage.config.initialize(Config {
            l1_program,
            interfold,
            ballot_domain: to_halves(ballot_domain_separator),
            availability_domain: to_halves(availability_domain_separator),
            signer_x: to_halves(availability_signer_pubkey_x),
            signer_y: to_halves(availability_signer_pubkey_y),
            ct0_vk_hash,
            ct1_vk_hash,
            crisp_vk_hash,
        });
    }

    // ---------------------------------------------------------------------------------------------------------
    // L1 -> L2 messages
    // ---------------------------------------------------------------------------------------------------------

    /// Opens a round from the ROUND message of `Interfold.request`. Anyone may call it; the message authenticates the
    /// arguments, and consuming it makes a round open once.
    #[external("public")]
    fn open_round(
        round_id: Field,
        num_options: Field,
        input_start: u64,
        input_end: u64,
        input_limit: u32,
        leaf_index: Field,
    ) {
        round_id.assert_max_bit_size::<96>();
        assert((input_limit != 0) & (input_limit <= MAX_LEAVES), "input limit out of range");
        assert(input_start < input_end, "empty input window");

        let config = self.storage.config.read();
        let content = round_content(round_id, num_options, input_start, input_end, input_limit);
        self.context.consume_l1_to_l2_message(content, [0], config.l1_program, leaf_index);

        self.storage.rounds.at(round_id).initialize(RoundConfig { num_options, input_start, input_end, input_limit });
        self.context.emit_public_log_unsafe(LOG_ROUND_OPENED, [round_id]);
    }

    /// Stores the committee public key from the KEY message of `publishCommitteeKey`. Anyone may call it.
    #[external("public")]
    fn publish_key(round_id: Field, committee_public_key: Field, leaf_index: Field) {
        let config = self.storage.config.read();
        self.context.consume_l1_to_l2_message(
            key_content(round_id, committee_public_key),
            [0],
            config.l1_program,
            leaf_index,
        );

        self.storage.committee_keys.at(round_id).initialize(committee_public_key);
        self.context.emit_public_log_unsafe(LOG_KEY_PUBLISHED, [round_id, committee_public_key]);
    }

    // ---------------------------------------------------------------------------------------------------------
    // Enrollment
    // ---------------------------------------------------------------------------------------------------------

    /// Adds `slot` with `weight` to the census from its ENROLL message. Anyone may call it: the message, sent by the
    /// L1 program from `getPastVotes` at the round snapshot, authenticates the weight. A slot enrolls once.
    #[external("public")]
    fn enroll(round_id: Field, slot: Field, weight: Field, leaf_index: Field) {
        let round = self.storage.rounds.at(round_id).read();
        assert(self.context.timestamp() < round.input_end, "enrollment closed");
        assert(weight != 0, "zero weight");

        let state = self.storage.slots.at(round_id).at(slot);
        assert(!state.read().enrolled, "slot already enrolled");
        state.write(SlotState { enrolled: true, binds: 0 });

        let config = self.storage.config.read();
        self.context.consume_l1_to_l2_message(
            enroll_content(round_id, slot, weight),
            [0],
            config.l1_program,
            leaf_index,
        );

        let census_leaf = hash_2([slot, weight]);
        let index = self.storage.counts.at(round_id).read().census;
        assert(index < MAX_LEAVES, "census full");
        let mut nodes = PublicNodes { nodes: self.storage.census_nodes.at(round_id) };
        let root = lean_insert(&mut nodes, index, census_leaf);
        let mut counts = self.storage.counts.at(round_id).read();
        counts.census = index + 1;
        self.storage.counts.at(round_id).write(counts);
        self.storage.census_roots.at(round_id).at(root).write(true);

        self.context.emit_public_log_unsafe(
            LOG_MEMBER_REGISTERED,
            [round_id, index as Field, slot, census_leaf, root],
        );
    }

    // ---------------------------------------------------------------------------------------------------------
    // Staging keys
    // ---------------------------------------------------------------------------------------------------------

    /// Binds a staging key of `slot` (at most `MAX_STAGING_BINDS` per round, so a lost key can be replaced). The slot's
    /// wallet signs the EIP-712 `StagingKey(uint256 e3Id)` of the ballot domain; the signature never leaves the device.
    /// The secret is derived from it and only its commitment is public, so a staging pass later proves membership
    /// without naming the slot.
    #[external("private")]
    fn bind_staging_key(
        round_id: Field,
        slot: Field,
        public_key_x: [u8; 32],
        public_key_y: [u8; 32],
        signature: [u8; 64],
    ) {
        let config = self.storage.config.read();
        let digest = staging_key_digest(from_halves(config.ballot_domain), full_e3_id(config.interfold, round_id));
        assert(
            std::ecdsa_secp256k1::verify_signature(public_key_x, public_key_y, signature, digest),
            "invalid staging key signature",
        );
        assert_eq(address_of(public_key_x, public_key_y), slot, "public key is not the slot");

        let commitment = staging_commitment(staging_secret(signature), round_id);
        self.enqueue_self._bind(round_id, slot, commitment);
    }

    #[external("public")]
    #[only_self]
    fn _bind(round_id: Field, slot: Field, commitment: Field) {
        let state = self.storage.slots.at(round_id).at(slot);
        let slot_state = state.read();
        assert(slot_state.enrolled, "slot not enrolled");
        assert(slot_state.binds < MAX_STAGING_BINDS, "too many staging keys bound");
        state.write(SlotState { enrolled: true, binds: slot_state.binds + 1 });

        let used = self.storage.staging_commitments.at(round_id).at(commitment);
        assert(!used.read(), "staging key already bound");
        used.write(true);

        let index = self.storage.counts.at(round_id).read().staging;
        assert(index < MAX_LEAVES, "staging tree full");
        let mut nodes = PublicNodes { nodes: self.storage.staging_nodes.at(round_id) };
        let root = lean_insert(&mut nodes, index, commitment);
        let mut counts = self.storage.counts.at(round_id).read();
        counts.staging = index + 1;
        self.storage.counts.at(round_id).write(counts);
        self.storage.staging_roots.at(round_id).at(root).write(true);

        self.context.emit_public_log_unsafe(LOG_STAGING_KEY_BOUND, [round_id, index as Field, slot, commitment, root]);
    }

    // ---------------------------------------------------------------------------------------------------------
    // Ballots
    // ---------------------------------------------------------------------------------------------------------

    /// Commits one ballot: the three base proofs of the ballot for `slot` (`user_data_encryption_ct0`,
    /// `user_data_encryption_ct1` and crisp, non-ZK UltraHonk proofs, which this private function keeps from the
    /// network), the availability service's attestation of the ciphertext, and the bytes the input tree leaf commits to.
    /// Votes and masks enter the same way.
    ///
    /// L1 verifies one fold of the three proofs; here the fold's two aggregation circuits are replaced by checking the
    /// proofs one by one and linking their public inputs (`ballot.nr` lists every check).
    #[external("private")]
    fn cast(
        round_id: Field,
        ct0_vk: UltraHonkVerificationKey,
        ct0_proof: UltraHonkProof,
        ct0_public_inputs: [Field; CT0_PUBLIC_INPUTS],
        ct1_vk: UltraHonkVerificationKey,
        ct1_proof: UltraHonkProof,
        ct1_public_inputs: [Field; CT1_PUBLIC_INPUTS],
        crisp_vk: UltraHonkVerificationKey,
        crisp_proof: UltraHonkProof,
        slot: Field,
        ct_commitment: Field,
        encrypted_vote_hash: [u8; 32],
        parent_index_plus_one: u32,
        prev_commitment: Field,
        census_root: Field,
        expires_at: u64,
        signature: [u8; 64],
    ) {
        let config = self.storage.config.read();
        let round = self.storage.rounds.at(round_id).read();
        let committee_key = self.storage.committee_keys.at(round_id).read();
        assert(encrypted_vote_hash != [0; 32], "empty encrypted vote hash");

        // Everything signed or proved off-chain names the round by its full Interfold e3Id.
        let e3_id = full_e3_id(config.interfold, round_id);

        // The crisp proof's public inputs, in the order the circuit declares them.
        let digest = to_halves(ballot_digest(from_halves(config.ballot_domain), e3_id, slot, ct_commitment));
        let crisp_pi = crisp_public_inputs(
            ct0_public_inputs,
            ct1_public_inputs,
            committee_key,
            [
                prev_commitment,
                digest[0],
                digest[1],
                slot,
                census_root,
                (parent_index_plus_one == 0) as Field,
                round.num_options,
                ct_commitment,
            ],
        );

        let ct0_vk_hash = Poseidon2::hash(ct0_vk, ct0_vk.len());
        assert_eq(ct0_vk_hash, config.ct0_vk_hash, "unexpected ct0 verification key");
        let ct1_vk_hash = Poseidon2::hash(ct1_vk, ct1_vk.len());
        assert_eq(ct1_vk_hash, config.ct1_vk_hash, "unexpected ct1 verification key");
        let crisp_vk_hash = Poseidon2::hash(crisp_vk, crisp_vk.len());
        assert_eq(crisp_vk_hash, config.crisp_vk_hash, "unexpected crisp verification key");
        verify_honk_proof_non_zk(ct0_vk, ct0_proof, ct0_public_inputs, ct0_vk_hash);
        verify_honk_proof_non_zk(ct1_vk, ct1_proof, ct1_public_inputs, ct1_vk_hash);
        verify_honk_proof_non_zk(crisp_vk, crisp_proof, crisp_pi, crisp_vk_hash);

        // The availability service attests that it holds the ciphertext behind this input.
        let id = input_id(
            config.l1_program,
            e3_id,
            encrypted_vote_hash,
            ct_commitment,
            slot,
            parent_index_plus_one,
        );
        let attestation = availability_digest(from_halves(config.availability_domain), e3_id, id, expires_at);
        assert(
            std::ecdsa_secp256k1::verify_signature(
                from_halves(config.signer_x),
                from_halves(config.signer_y),
                signature,
                attestation,
            ),
            "invalid availability attestation",
        );

        // The id as a field, to mark it used. 31 bytes keep it below the modulus.
        let mut id_prefix = [0; 31];
        for i in 0..31 {
            id_prefix[i] = id[i];
        }
        let vote_hash = to_halves(encrypted_vote_hash);
        self.enqueue_self._append_input(
            round_id,
            slot,
            ct_commitment,
            prev_commitment,
            census_root,
            parent_index_plus_one,
            input_leaf(encrypted_vote_hash, ct_commitment, slot, parent_index_plus_one),
            bytes_to_field(id_prefix),
            expires_at,
            vote_hash[0],
            vote_hash[1],
        );
    }

    #[external("public")]
    #[only_self]
    fn _append_input(
        round_id: Field,
        slot: Field,
        ct_commitment: Field,
        prev_commitment: Field,
        census_root: Field,
        parent_index_plus_one: u32,
        leaf: Field,
        input_key: Field,
        expires_at: u64,
        vote_hash_hi: Field,
        vote_hash_lo: Field,
    ) {
        let round = self.storage.rounds.at(round_id).read();
        let now = self.context.timestamp();
        assert((round.input_start <= now) & (now < round.input_end), "outside the input window");
        assert(now < expires_at, "availability attestation expired");
        assert(self.storage.census_roots.at(round_id).at(census_root).read(), "unknown census root");

        let index = self.storage.counts.at(round_id).read().inputs;
        assert(index < round.input_limit, "input limit reached");

        if parent_index_plus_one == 0 {
            assert(prev_commitment == 0, "first ballot names a parent commitment");
        } else {
            let parent = self.storage.inputs.at(round_id).at(parent_index_plus_one - 1).read();
            assert(
                (prev_commitment != 0) & (parent.slot == slot) & (parent.commitment == prev_commitment),
                "parent does not match",
            );
        }

        let used = self.storage.input_ids.at(round_id).at(input_key);
        assert(!used.read(), "input already committed");
        used.write(true);

        self.storage.inputs.at(round_id).at(index).write(InputEntry { slot, commitment: ct_commitment });
        let mut nodes = PublicNodes { nodes: self.storage.input_frontier.at(round_id) };
        lazy_insert(&mut nodes, index, leaf);
        let mut counts = self.storage.counts.at(round_id).read();
        counts.inputs = index + 1;
        self.storage.counts.at(round_id).write(counts);

        self.context.emit_public_log_unsafe(
            LOG_INPUT_COMMITTED,
            [
                round_id,
                index as Field,
                slot,
                ct_commitment,
                vote_hash_hi,
                vote_hash_lo,
                parent_index_plus_one as Field,
            ],
        );
    }

    // ---------------------------------------------------------------------------------------------------------
    // Closing
    // ---------------------------------------------------------------------------------------------------------

    /// Seals the round after its input window, sends `(roundId, inputRoot, numInputs)` to L1 and returns the input root.
    /// Anyone may call it, once.
    #[external("public")]
    fn close_round(round_id: Field) -> Field {
        let round = self.storage.rounds.at(round_id).read();
        assert(self.context.timestamp() >= round.input_end, "input window still open");

        let closed = self.storage.closed.at(round_id);
        assert(!closed.read(), "round already closed");
        closed.write(true);

        let count = self.storage.counts.at(round_id).read().inputs;
        let mut nodes = PublicNodes { nodes: self.storage.input_frontier.at(round_id) };
        let root = lazy_root(&mut nodes, count);

        let config = self.storage.config.read();
        self.context.message_portal(config.l1_program, root_content(round_id, root, count));
        self.context.emit_public_log_unsafe(LOG_ROUND_CLOSED, [round_id, root, count as Field]);
        root
    }

    // ---------------------------------------------------------------------------------------------------------
    // Views
    // ---------------------------------------------------------------------------------------------------------

    #[external("utility")]
    unconstrained fn get_config() -> Config {
        self.storage.config.read()
    }

    #[external("utility")]
    unconstrained fn get_round(round_id: Field) -> RoundConfig {
        self.storage.rounds.at(round_id).read()
    }

    #[external("utility")]
    unconstrained fn get_committee_key(round_id: Field) -> Field {
        self.storage.committee_keys.at(round_id).read()
    }

    #[external("utility")]
    unconstrained fn is_closed(round_id: Field) -> bool {
        self.storage.closed.at(round_id).read()
    }

    #[external("utility")]
    unconstrained fn get_input_count(round_id: Field) -> u32 {
        self.storage.counts.at(round_id).read().inputs
    }

    #[external("utility")]
    unconstrained fn get_census_count(round_id: Field) -> u32 {
        self.storage.counts.at(round_id).read().census
    }

    /// The census root now; 0 before the first enrollment.
    #[external("utility")]
    unconstrained fn get_census_root(round_id: Field) -> Field {
        let count = self.storage.counts.at(round_id).read().census;
        if count == 0 {
            0
        } else {
            self.storage.census_nodes.at(round_id).at(ceil_log2(count)).read()
        }
    }

    #[external("utility")]
    unconstrained fn is_census_root_known(round_id: Field, root: Field) -> bool {
        self.storage.census_roots.at(round_id).at(root).read()
    }

    #[external("utility")]
    unconstrained fn is_slot_enrolled(round_id: Field, slot: Field) -> bool {
        self.storage.slots.at(round_id).at(slot).read().enrolled
    }

    #[external("utility")]
    unconstrained fn get_input(round_id: Field, index: u32) -> InputEntry {
        self.storage.inputs.at(round_id).at(index).read()
    }

    #[external("utility")]
    unconstrained fn get_staging_bind_count(round_id: Field, slot: Field) -> u8 {
        self.storage.slots.at(round_id).at(slot).read().binds
    }

    /// The staging root now; 0 before the first binding.
    #[external("utility")]
    unconstrained fn get_staging_root(round_id: Field) -> Field {
        let count = self.storage.counts.at(round_id).read().staging;
        if count == 0 {
            0
        } else {
            self.storage.staging_nodes.at(round_id).at(ceil_log2(count)).read()
        }
    }

    #[external("utility")]
    unconstrained fn is_staging_root_known(round_id: Field, root: Field) -> bool {
        self.storage.staging_roots.at(round_id).at(root).read()
    }
}
