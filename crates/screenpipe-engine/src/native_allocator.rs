// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Configure native allocation retention before starting a runtime or recorder.

/// Disable libmalloc's large-allocation cache unless the launcher supplied an
/// explicit policy. XZM's pressure-relief callback is a no-op; freed CoreML
/// compilation buffers otherwise remain resident alongside the Rust heap.
///
/// libmalloc reads this option during process initialization, before `main`.
/// Setting it here alone is too late: replace this process once, preserving its
/// PID, executable, arguments and inherited environment. The replacement sees
/// the option and returns without exec, before any recording has started.
#[cfg(target_os = "macos")]
pub fn prepare_native_heap() -> std::io::Result<()> {
    use std::os::unix::process::CommandExt;
    if std::env::var_os("MallocLargeCache").is_some() {
        return Ok(());
    }
    let error = std::process::Command::new(std::env::current_exe()?)
        .args(std::env::args_os().skip(1))
        .env("MallocLargeCache", "0")
        .exec();
    Err(error)
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    #[test]
    fn startup_preserves_pid_arguments_and_explicit_allocator_policy() {
        const CHILD: &str = "SCREENPIPE_NATIVE_ALLOCATOR_TEST_CHILD";
        if let Ok(expected) = std::env::var(CHILD) {
            super::prepare_native_heap().unwrap();
            assert_eq!(std::env::var("MallocLargeCache").unwrap(), expected);
            println!("native_allocator_pid={}", std::process::id());
            return;
        }
        for policy in [None, Some("0"), Some("1")] {
            let mut command = std::process::Command::new(std::env::current_exe().unwrap());
            command.args([
                "--exact",
                "native_allocator::tests::startup_preserves_pid_arguments_and_explicit_allocator_policy",
                "--nocapture",
                "--test-threads=1",
            ]).env(CHILD, policy.unwrap_or("0")).env_remove("MallocLargeCache");
            if let Some(policy) = policy {
                command.env("MallocLargeCache", policy);
            }
            let child = command
                .stdout(std::process::Stdio::piped())
                .stderr(std::process::Stdio::piped())
                .spawn()
                .unwrap();
            let pid = child.id();
            let result = child.wait_with_output().unwrap();
            assert!(
                result.status.success(),
                "{}",
                String::from_utf8_lossy(&result.stderr)
            );
            assert!(String::from_utf8_lossy(&result.stdout)
                .contains(&format!("native_allocator_pid={pid}")));
        }
    }
}
