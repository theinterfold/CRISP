// Incremental Merkle trees over a level-indexed node store.
//
// Both trees keep only a frontier (one node per level), which is all an append-only tree needs:
// - the input tree reproduces zk-kit `InternalLazyIMT` roots (dynamic depth, zero-padded),
// - the census tree is zk-kit `InternalLeanIMT`.
// Hashing is circom Poseidon `hash_2`, the same function the Solidity libraries and the ballot circuit use.

use crate::constants::LAZY_ZEROS;
use poseidon::poseidon::bn254::hash_2;

/// Level-indexed node storage. The contract backs it with public storage; tests with an array.
pub trait NodeStore {
    unconstrained fn get(self, level: u32) -> Field;
    unconstrained fn set(&mut self, level: u32, value: Field);
}

/// Smallest `d >= 0` with `2^d >= n`.
pub unconstrained fn ceil_log2(n: u32) -> u32 {
    let mut d = 0;
    while (1 << d) < n {
        d += 1;
    }
    d
}

unconstrained fn trailing_zeros(n: u32) -> u32 {
    let mut z = 0;
    while ((n >> z) & 1) == 0 {
        z += 1;
    }
    z
}

/// Appends `leaf` at position `index` (the leaf count before the insert) of the input tree.
///
/// `frontier[i]` ends up holding the latest completed node of level `i` that sits at an even position, which is the
/// only node a later insert or the root needs. Costs one hash per trailing one bit of `index` and one write.
pub unconstrained fn lazy_insert<S>(store: &mut S, index: u32, leaf: Field)
where
    S: NodeStore,
{
    let mut node = leaf;
    let mut level = 0;
    while ((index >> level) & 1) == 1 {
        node = hash_2([store.get(level), node]);
        level += 1;
    }
    store.set(level, node);
}

/// Root of the input tree of `n` leaves, equal to `InternalLazyIMT._root()` of the same leaves.
///
/// The depth is the smallest `d >= 1` with `2^d >= n`. An empty tree has the root of an empty depth-1 tree. Costs one
/// hash per level between the lowest set bit of `n` and the depth.
pub unconstrained fn lazy_root<S>(store: &mut S, n: u32) -> Field
where
    S: NodeStore,
{
    if n == 0 {
        LAZY_ZEROS[1]
    } else {
        let mut depth = ceil_log2(n);
        if depth == 0 {
            depth = 1;
        }
        if n == (1 << depth) {
            // A full tree: its root is the completed node of the top level.
            store.get(depth)
        } else {
            // Fold the completed nodes (one per set bit of `n`) from the lowest level up, padding with empty
            // subtrees where `n` has a clear bit.
            let low = trailing_zeros(n);
            let mut acc = LAZY_ZEROS[low];
            let mut level = low;
            while level < depth {
                if ((n >> level) & 1) == 1 {
                    acc = hash_2([store.get(level), acc]);
                } else {
                    acc = hash_2([acc, LAZY_ZEROS[level]]);
                }
                level += 1;
            }
            acc
        }
    }
}

/// Appends `leaf` at position `index` of the census tree (`InternalLeanIMT._insert`) and returns the new root.
///
/// `store[level]` holds the last even-position node of each level and `store[depth]` the root.
pub unconstrained fn lean_insert<S>(store: &mut S, index: u32, leaf: Field) -> Field
where
    S: NodeStore,
{
    let depth = ceil_log2(index + 1);
    let mut node = leaf;
    let mut level = 0;
    while level < depth {
        if ((index >> level) & 1) == 1 {
            node = hash_2([store.get(level), node]);
        } else {
            store.set(level, node);
        }
        level += 1;
    }
    store.set(depth, node);
    node
}

/// Root of the census tree of `n` leaves; 0 for an empty tree.
pub unconstrained fn lean_root<S>(store: &mut S, n: u32) -> Field
where
    S: NodeStore,
{
    if n == 0 {
        0
    } else {
        store.get(ceil_log2(n))
    }
}
