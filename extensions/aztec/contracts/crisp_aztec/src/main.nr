pub mod constants;
pub mod hashing;
pub mod identity;
pub mod nodes;
pub mod tree;
mod tests;
pub mod types;

use aztec::macros::aztec;

/// CRISP on Aztec: voters register with a ZKPassport proof and cast fold-proven ballots; the contract builds the
/// census tree and the input tree, and sends the input root to L1 when the round closes.
#[aztec]
pub contract CrispAztec {
    use crate::{
        constants::{
            LOG_INPUT_COMMITTED, LOG_KEY_PUBLISHED, LOG_MEMBER_REGISTERED, LOG_ROUND_CLOSED, LOG_ROUND_OPENED,
            MAX_LEAVES,
        },
        hashing::{
            availability_digest, ballot_digest, from_halves, full_e3_id, input_id, input_leaf, key_content, round_content,
            root_content, to_halves, bytes_to_field,
        },
        identity::service_config,
        nodes::PublicNodes,
        tree::{ceil_log2, lazy_insert, lazy_root, lean_insert},
        types::{Config, InputEntry, RoundConfig},
    };
    use aztec::{
        macros::{functions::{external, initializer, only_self}, storage::storage},
        protocol::address::{AztecAddress, EthAddress},
        state_vars::{Map, PublicImmutable, PublicMutable},
    };
    use bb_proof_verification::{UltraHonkVerificationKey, UltraHonkZKProof, verify_honk_proof};
    use poseidon::{poseidon::bn254::hash_2, poseidon2::Poseidon2};
    use zkpassport_aztec_verifier::{
        query::Query,
        verify::{emit_uniqueness_nullifier, verify_zkpassport_proof_with_registry},
    };

    #[storage]
    struct Storage<Context> {
        config: PublicImmutable<Config, Context>,
        // Round parameters and committee key, written once each from an L1 message.
        rounds: Map<Field, PublicImmutable<RoundConfig, Context>, Context>,
        committee_keys: Map<Field, PublicImmutable<Field, Context>, Context>,
        closed: Map<Field, PublicMutable<bool, Context>, Context>,
        // Census tree (LeanIMT): leaf count, frontier by level (the root is the node at the tree's depth), every
        // root a member proof may have been made against, and the slots already registered.
        census_count: Map<Field, PublicMutable<u32, Context>, Context>,
        census_nodes: Map<Field, Map<u32, PublicMutable<Field, Context>, Context>, Context>,
        census_roots: Map<Field, Map<Field, PublicMutable<bool, Context>, Context>, Context>,
        registered_slots: Map<Field, Map<Field, PublicMutable<bool, Context>, Context>, Context>,
        // Input tree (LazyIMT): leaf count, frontier by level, the (slot, commitment) of each input for the parent
        // rule, and the ids of the inputs already committed.
        input_count: Map<Field, PublicMutable<u32, Context>, Context>,
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
        fold_vk_hash: Field,
        zkpassport_domain_hash: Field,
        zkpassport_circuit_version: Field,
        zkpassport_validity_period: u64,
        zkpassport_registry: AztecAddress,
    ) {
        self.storage.config.initialize(Config {
            l1_program,
            interfold,
            ballot_domain: to_halves(ballot_domain_separator),
            availability_domain: to_halves(availability_domain_separator),
            signer_x: to_halves(availability_signer_pubkey_x),
            signer_y: to_halves(availability_signer_pubkey_y),
            fold_vk_hash,
            zkpassport_domain: zkpassport_domain_hash,
            zkpassport_version: zkpassport_circuit_version,
            zkpassport_validity_period,
            zkpassport_registry,
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
        credits: Field,
        input_start: u64,
        input_end: u64,
        input_limit: u32,
        scope_hash: Field,
        min_age: u8,
        allow_mock_documents: bool,
        leaf_index: Field,
    ) {
        round_id.assert_max_bit_size::<96>();
        assert((input_limit != 0) & (input_limit <= MAX_LEAVES), "input limit out of range");
        assert(input_start < input_end, "empty input window");

        let config = self.storage.config.read();
        let content = round_content(
            round_id,
            num_options,
            credits,
            input_start,
            input_end,
            input_limit,
            scope_hash,
            min_age,
            allow_mock_documents,
        );
        self.context.consume_l1_to_l2_message(content, [0], config.l1_program, leaf_index);

        self.storage.rounds.at(round_id).initialize(RoundConfig {
            num_options,
            credits,
            input_start,
            input_end,
            input_limit,
            scope_hash,
            min_age,
            allow_mock_documents,
        });
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
    // Registration
    // ---------------------------------------------------------------------------------------------------------

    /// Registers `slot` for a round that sets no minimum age. The caller proves, with a ZKPassport proof bound to its
    /// own address and delivered in the proof capsule, that it holds a document nobody registered in this round.
    #[external("private")]
    fn register(round_id: Field, slot: Field) {
        let config = self.storage.config.read();
        let round = self.storage.rounds.at(round_id).read();
        assert(round.min_age == 0, "round requires an age proof");

        let user = self.msg_sender();
        let query = Query::new().bind_user_address(user);
        let verified = verify_zkpassport_proof_with_registry(
            self.context,
            config.zkpassport_registry,
            user,
            service_config(config, round),
            query,
        );
        emit_uniqueness_nullifier(self.context, verified.unique_identifier);

        let census_leaf = hash_2([slot, round.credits]);
        self.enqueue_self._add_member(round_id, slot, census_leaf);
    }

    /// Registers `slot` for a round with a minimum age: the proof must also show the holder is at least that old.
    #[external("private")]
    fn register_with_age(round_id: Field, slot: Field) {
        let config = self.storage.config.read();
        let round = self.storage.rounds.at(round_id).read();
        assert(round.min_age != 0, "round has no age requirement");

        let user = self.msg_sender();
        let query = Query::new().age_min(round.min_age).bind_user_address(user);
        let verified = verify_zkpassport_proof_with_registry(
            self.context,
            config.zkpassport_registry,
            user,
            service_config(config, round),
            query,
        );
        emit_uniqueness_nullifier(self.context, verified.unique_identifier);

        let census_leaf = hash_2([slot, round.credits]);
        self.enqueue_self._add_member(round_id, slot, census_leaf);
    }

    #[external("public")]
    #[only_self]
    fn _add_member(round_id: Field, slot: Field, census_leaf: Field) {
        let round = self.storage.rounds.at(round_id).read();
        assert(self.context.timestamp() < round.input_end, "registration closed");

        let registered = self.storage.registered_slots.at(round_id).at(slot);
        assert(!registered.read(), "slot already registered");
        registered.write(true);

        let index = self.storage.census_count.at(round_id).read();
        assert(index < MAX_LEAVES, "census full");
        let mut nodes = PublicNodes { nodes: self.storage.census_nodes.at(round_id) };
        let root = lean_insert(&mut nodes, index, census_leaf);
        self.storage.census_count.at(round_id).write(index + 1);
        self.storage.census_roots.at(round_id).at(root).write(true);

        self.context.emit_public_log_unsafe(
            LOG_MEMBER_REGISTERED,
            [round_id, index as Field, slot, census_leaf, root],
        );
    }

    // ---------------------------------------------------------------------------------------------------------
    // Ballots
    // ---------------------------------------------------------------------------------------------------------

    /// Commits one ballot: a fold proof for `slot`, the availability service's attestation of the ciphertext, and the
    /// bytes the input tree leaf commits to. Votes and masks enter the same way.
    #[external("private")]
    fn cast(
        round_id: Field,
        vk: UltraHonkVerificationKey,
        proof: UltraHonkZKProof,
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

        // The fold proof's public inputs, in the order the circuit declares them.
        let digest = to_halves(ballot_digest(from_halves(config.ballot_domain), e3_id, slot, ct_commitment));
        let public_inputs = [
            prev_commitment,
            digest[0],
            digest[1],
            slot,
            census_root,
            (parent_index_plus_one == 0) as Field,
            round.num_options,
            ct_commitment,
            committee_key,
        ];
        let vk_hash = Poseidon2::hash(vk, vk.len());
        assert_eq(vk_hash, config.fold_vk_hash, "unexpected fold verification key");
        verify_honk_proof(vk, proof, public_inputs, vk_hash);

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

        let index = self.storage.input_count.at(round_id).read();
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
        self.storage.input_count.at(round_id).write(index + 1);

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

        let count = self.storage.input_count.at(round_id).read();
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
        self.storage.input_count.at(round_id).read()
    }

    #[external("utility")]
    unconstrained fn get_census_count(round_id: Field) -> u32 {
        self.storage.census_count.at(round_id).read()
    }

    /// The census root now; 0 before the first registration.
    #[external("utility")]
    unconstrained fn get_census_root(round_id: Field) -> Field {
        let count = self.storage.census_count.at(round_id).read();
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
    unconstrained fn is_slot_registered(round_id: Field, slot: Field) -> bool {
        self.storage.registered_slots.at(round_id).at(slot).read()
    }

    #[external("utility")]
    unconstrained fn get_input(round_id: Field, index: u32) -> InputEntry {
        self.storage.inputs.at(round_id).at(index).read()
    }
}
