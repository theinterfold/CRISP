//! Code `CrispAztec` and `CrispAztecVotes` share: the base-proof checks of a ballot, the byte encodings, the two
//! Merkle trees over a node store, the log tags and the input entry type.
pub mod ballot;
pub mod constants;
pub mod hashing;
pub mod nodes;
pub mod tree;
pub mod types;
