use aztec::protocol::traits::{Deserialize, Packable, Serialize};

/// What the contract remembers of an input, to check the parent of a later one.
#[derive(Deserialize, Eq, Packable, Serialize)]
pub struct InputEntry {
    pub slot: Field,
    pub commitment: Field,
}
