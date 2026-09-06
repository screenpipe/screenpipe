// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

/// Decide whether an exited native Pi process should make its next automatic
/// restart ignore third-party extensions.
pub(crate) fn should_enable_pi_extension_safe_mode_on_exit(
    use_acp: bool,
    termination_expected: bool,
    already_in_safe_mode: bool,
) -> bool {
    !use_acp && !termination_expected && !already_in_safe_mode
}

#[cfg(test)]
mod tests {
    use super::should_enable_pi_extension_safe_mode_on_exit;

    #[test]
    fn silent_unexpected_native_exit_enables_safe_mode() {
        assert!(should_enable_pi_extension_safe_mode_on_exit(
            false, false, false
        ));
    }

    #[test]
    fn intentional_stop_does_not_enable_safe_mode() {
        assert!(!should_enable_pi_extension_safe_mode_on_exit(
            false, true, false
        ));
    }

    #[test]
    fn acp_exit_does_not_enable_pi_extension_safe_mode() {
        assert!(!should_enable_pi_extension_safe_mode_on_exit(
            true, false, false
        ));
    }

    #[test]
    fn safe_mode_exit_does_not_rearm_safe_mode() {
        assert!(!should_enable_pi_extension_safe_mode_on_exit(
            false, false, true
        ));
    }
}
