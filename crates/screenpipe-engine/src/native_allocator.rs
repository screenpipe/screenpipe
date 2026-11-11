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
/// If lookup or exec fails, warn and continue recording with allocator defaults.
#[cfg(target_os = "macos")]
pub fn prepare_native_heap() {
    if std::env::var_os("MallocLargeCache").is_some() {
        return;
    }
    prepare_native_heap_for_executable(std::env::current_exe())
}

fn prepare_native_heap_for_executable(executable: std::io::Result<std::path::PathBuf>) {
    use std::os::unix::process::CommandExt;
    let result: std::io::Result<()> = executable.and_then(|executable| {
        // CommandExt::exec resets SIGPIPE before execve, even when execve fails.
        // Preserve the caller's signal behavior when this optional setup falls back.
        // This runs before starting any runtime or recording threads.
        let mut previous = std::mem::MaybeUninit::<libc::sigaction>::uninit();
        if unsafe { libc::sigaction(libc::SIGPIPE, std::ptr::null(), previous.as_mut_ptr()) } != 0 {
            return Err(std::io::Error::last_os_error());
        }
        let previous = unsafe { previous.assume_init() };
        let error = std::process::Command::new(executable)
            .args(std::env::args_os().skip(1))
            .env("MallocLargeCache", "0")
            .exec();
        if unsafe { libc::sigaction(libc::SIGPIPE, &previous, std::ptr::null_mut()) } != 0 {
            eprintln!(
                "Unable to restore SIGPIPE after failed native allocator setup: {}",
                std::io::Error::last_os_error()
            );
        }
        Err(error)
    });
    if let Err(error) = result {
        eprintln!("Unable to apply native allocator cache policy: {error}; continuing with allocator defaults");
    }
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    fn assert_startup_can_continue<T: std::process::Termination>(start: impl FnOnce() -> T) {
        assert_eq!(
            start().report(),
            std::process::ExitCode::SUCCESS,
            "optional native heap tuning must not stop recording startup"
        );
    }

    #[test]
    fn executable_lookup_failure_does_not_stop_startup() {
        assert_startup_can_continue(|| {
            super::prepare_native_heap_for_executable(Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "executable lookup failed",
            )))
        });
    }

    #[test]
    fn reexec_failure_does_not_stop_startup() {
        // ENOENT exercises the real failed exec path, without replacing this process.
        assert_startup_can_continue(|| {
            super::prepare_native_heap_for_executable(Ok(std::path::PathBuf::from(
                "/screenpipe-missing-native-heap-test/executable",
            )))
        });
    }
    #[test]
    fn failed_reexec_preserves_sigpipe_handler() {
        const CHILD: &str = "SCREENPIPE_NATIVE_ALLOCATOR_SIGNAL_TEST_CHILD";
        if std::env::var_os(CHILD).is_some() {
            // Isolate process-global signal state from the other tests.
            unsafe { libc::signal(libc::SIGPIPE, libc::SIG_IGN) };
            super::prepare_native_heap_for_executable(Ok(std::path::PathBuf::from(
                "/screenpipe-missing-native-heap-test/executable",
            )));
            let mut action = std::mem::MaybeUninit::<libc::sigaction>::uninit();
            assert_eq!(
                unsafe { libc::sigaction(libc::SIGPIPE, std::ptr::null(), action.as_mut_ptr()) },
                0
            );
            assert_eq!(unsafe { action.assume_init() }.sa_sigaction, libc::SIG_IGN);
            return;
        }
        let output = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "native_allocator::tests::failed_reexec_preserves_sigpipe_handler",
                "--nocapture",
                "--test-threads=1",
            ])
            .env(CHILD, "1")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stdout)
        );
    }

    #[test]
    fn startup_preserves_pid_arguments_and_explicit_allocator_policy() {
        const CHILD: &str = "SCREENPIPE_NATIVE_ALLOCATOR_TEST_CHILD";
        if let Ok(expected) = std::env::var(CHILD) {
            super::prepare_native_heap();
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
