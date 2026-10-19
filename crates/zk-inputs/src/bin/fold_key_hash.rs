// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

//! Prints the key hash that a CRISP fold circuit binds.
//!
//! Usage: `fold_key_hash <user_data_encryption> <ballot> <ct0> <ct1>`. Each argument is a
//! `noir-recursive-no-zk` verification key hash file: 32 big-endian bytes, as `bb write_vk`
//! writes it. The fold circuit hashes the four keys in this order with `compute_vk_hash`.

use ark_bn254::Fr;
use ark_ff::{BigInteger, PrimeField};
use e3_zk_witness::compute_vk_hash;
use eyre::{bail, Context, ContextCompat, Result};
use std::path::Path;

fn field_from_file(path: &Path) -> Result<Fr> {
    let bytes = std::fs::read(path).with_context(|| format!("read {}", path.display()))?;
    if bytes.len() != 32 {
        bail!("{}: expected 32 bytes, got {}", path.display(), bytes.len());
    }
    let limbs = std::array::from_fn(|i| {
        u64::from_be_bytes(bytes[(3 - i) * 8..(4 - i) * 8].try_into().unwrap())
    });
    Fr::from_bigint(ark_ff::BigInt::<4>::new(limbs)).with_context(|| {
        format!(
            "{}: the hash is not a canonical field element",
            path.display()
        )
    })
}

fn main() -> Result<()> {
    let paths: Vec<String> = std::env::args().skip(1).collect();
    if paths.len() != 4 {
        bail!("usage: fold_key_hash <user_data_encryption> <ballot> <ct0> <ct1>");
    }
    let fields = paths
        .iter()
        .map(|path| field_from_file(Path::new(path)))
        .collect::<Result<Vec<_>>>()?;
    let hash = compute_vk_hash(fields).into_bigint().to_bytes_be();
    println!("0x{}", hex::encode(hash));
    Ok(())
}
