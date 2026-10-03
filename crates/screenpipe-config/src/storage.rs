// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Storage constraints are independent of CPU/RAM performance tier.
const GIB: u64 = 1024 * 1024 * 1024;

pub fn storage_is_small(total: u64) -> bool {
    total > 0 && total <= 256 * GIB
}

pub fn storage_is_low(total: u64, available: u64) -> bool {
    total > 0
        && available <= total
        && (available <= 20 * GIB || (available < 50 * GIB && available <= total / 10))
}

/// Only used for a genuinely new store with no existing recordings or choice.
/// Unknown measurements retain the ordinary 14-day media default.
pub fn initial_media_retention_days(total: u64, available: u64) -> u32 {
    if total > 0
        && available <= total
        && (storage_is_small(total) || storage_is_low(total, available))
    {
        7
    } else {
        14
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capacity_and_pressure_are_independent() {
        assert!(storage_is_small(128 * GIB));
        assert!(!storage_is_low(128 * GIB, 80 * GIB));
        assert!(!storage_is_small(2048 * GIB));
        assert!(storage_is_low(2048 * GIB, 12 * GIB));
        assert_eq!(initial_media_retention_days(128 * GIB, 80 * GIB), 7);
        assert_eq!(initial_media_retention_days(2048 * GIB, 12 * GIB), 7);
    }

    #[test]
    fn healthy_large_drives_and_unknown_samples_keep_normal_default() {
        for (total, available) in [(2048 * GIB, 180 * GIB), (0, 0), (100, 101)] {
            assert_eq!(initial_media_retention_days(total, available), 14);
        }
        assert!(!storage_is_low(0, 0));
        assert!(!storage_is_low(100, 101));
    }

    #[test]
    fn boundaries_are_explicit_and_small_percentages_are_bounded() {
        assert!(storage_is_small(256 * GIB));
        assert!(!storage_is_small(256 * GIB + 1));
        assert!(storage_is_low(256 * GIB, 20 * GIB));
        assert!(storage_is_low(400 * GIB, 40 * GIB));
        assert!(!storage_is_low(400 * GIB, 40 * GIB + 1));
        assert!(!storage_is_low(2048 * GIB, 50 * GIB));
    }

    #[test]
    fn storage_cannot_change_the_performance_tier() {
        assert_eq!(crate::classify_tier(32, 8), crate::DeviceTier::High);
        assert_eq!(initial_media_retention_days(2048 * GIB, 5 * GIB), 7);
        assert_eq!(crate::classify_tier(32, 8), crate::DeviceTier::High);
    }
}
