// SPDX-License-Identifier: LGPL-3.0-only
//
// This file is provided WITHOUT ANY WARRANTY;
// without even the implied warranty of MERCHANTABILITY
// or FITNESS FOR A PARTICULAR PURPOSE.

/// Whether the inputs the server indexed are the inputs the L1 root commits to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Readiness {
    /// The server still lacks `expected - indexed` inputs. Computing now would tally a subset and
    /// derive a root the L1 program rejects, with no other symptom.
    Waiting { indexed: usize, expected: u64 },
    /// The indexed inputs are exactly the root's inputs.
    Ready,
    /// The server holds more inputs than the root counts. The index and the root disagree, and no
    /// amount of waiting repairs that.
    Inconsistent { indexed: usize, expected: u64 },
}

/// Compare the indexed input count with the `numInputs` of the L1 `InputRootSubmitted` event.
///
/// The root is the authority: the L2 closes a round once, so the count never changes after the
/// event, and equality is the only state in which the indexed inputs reproduce its tree.
pub fn readiness(indexed: usize, expected: u64) -> Readiness {
    match u64::try_from(indexed).map(|count| count.cmp(&expected)) {
        Ok(std::cmp::Ordering::Equal) => Readiness::Ready,
        Ok(std::cmp::Ordering::Less) => Readiness::Waiting { indexed, expected },
        Ok(std::cmp::Ordering::Greater) | Err(_) => Readiness::Inconsistent { indexed, expected },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn compute_waits_for_every_input_the_root_counts() {
        assert_eq!(
            readiness(2, 3),
            Readiness::Waiting {
                indexed: 2,
                expected: 3
            }
        );
        assert_eq!(readiness(3, 3), Readiness::Ready);
    }

    #[test]
    fn an_empty_round_is_ready_when_the_root_counts_nothing() {
        assert_eq!(readiness(0, 0), Readiness::Ready);
    }

    #[test]
    fn surplus_inputs_are_an_inconsistency_not_a_reason_to_wait() {
        assert_eq!(
            readiness(4, 3),
            Readiness::Inconsistent {
                indexed: 4,
                expected: 3
            }
        );
    }
}
