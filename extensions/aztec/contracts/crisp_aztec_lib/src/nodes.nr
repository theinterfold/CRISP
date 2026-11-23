use crate::tree::NodeStore;
use aztec::{context::PublicContext, state_vars::{Map, PublicMutable}};

/// A tree frontier kept in public storage, one slot per level.
pub struct PublicNodes {
    pub nodes: Map<u32, PublicMutable<Field, PublicContext>, PublicContext>,
}

impl NodeStore for PublicNodes {
    unconstrained fn get(self, level: u32) -> Field {
        self.nodes.at(level).read()
    }

    unconstrained fn set(&mut self, level: u32, value: Field) {
        self.nodes.at(level).write(value);
    }
}
