// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Configure native allocation retention before starting a runtime or recorder.

const BOOTSTRAP_MARKER: &str = "SCREENPIPE_NATIVE_HEAP_BOOTSTRAPPED";

/// Disable native large-allocation retention before starting runtime threads.
/// libmalloc reads this policy before main, so direct starts re-exec once.
/// Launch Services supplies the policy and marker together. Once initialized,
/// remove only our injected setting so unrelated children retain their defaults;
/// explicit caller policies remain inherited. Lookup/exec failures are nonfatal.
#[cfg(target_os = "macos")]
pub fn prepare_native_heap() {
    use std::sync::atomic::{AtomicBool, Ordering};
    static PREPARED: AtomicBool = AtomicBool::new(false);
    if PREPARED.swap(true, Ordering::Relaxed) {
        return;
    }
    if std::env::var_os(BOOTSTRAP_MARKER).as_deref() == Some(std::ffi::OsStr::new("1")) {
        match std::env::var_os("MallocLargeCache").as_deref() {
            Some(policy) if policy == std::ffi::OsStr::new("0") => {
                // Initialization is complete. Do this before starting threads.
                std::env::remove_var("MallocLargeCache");
            }
            None => eprintln!("Native allocator policy was removed by the launcher; continuing with allocator defaults"),
            _ => {} // Preserve an explicit replacement policy.
        }
        std::env::remove_var(BOOTSTRAP_MARKER);
        return;
    }
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
        let error = std::process::Command::new(&executable)
            .arg0(
                std::env::args_os()
                    .next()
                    .unwrap_or_else(|| executable.as_os_str().to_owned()),
            )
            .args(std::env::args_os().skip(1))
            .env("MallocLargeCache", "0")
            .env(BOOTSTRAP_MARKER, "1")
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
    use std::os::unix::process::CommandExt;
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
            "stdout: {}\nstderr: {}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }

    #[test]
    fn startup_preserves_pid_arguments_and_explicit_allocator_policy() {
        const CHILD: &str = "SCREENPIPE_NATIVE_ALLOCATOR_TEST_CHILD";
        if let Ok(expected) = std::env::var(CHILD) {
            super::prepare_native_heap();
            // Repeated calls must not re-exec after removing our injected env.
            super::prepare_native_heap();
            assert_eq!(
                std::env::args_os().next().unwrap(),
                "screenpipe-native-heap-test"
            );
            assert!(std::env::var_os(super::BOOTSTRAP_MARKER).is_none());
            let policy = std::env::var("MallocLargeCache").ok();
            assert_eq!(
                policy.as_deref(),
                (expected != "unset").then_some(expected.as_str())
            );
            let child = std::process::Command::new("/usr/bin/printenv")
                .arg("MallocLargeCache")
                .output()
                .unwrap();
            if expected == "unset" {
                assert!(
                    !child.status.success(),
                    "injected policy leaked into external child"
                );
            } else {
                assert!(child.status.success());
                assert_eq!(String::from_utf8(child.stdout).unwrap().trim(), expected);
            }
            println!("native_allocator_pid={}", std::process::id());
            return;
        }
        // Direct start, caller overrides, Launch Services and a stripped policy.
        for (policy, marked, expected) in [
            (None, false, "unset"),
            (Some("0"), false, "0"),
            (Some("1"), false, "1"),
            (Some("0"), true, "unset"),
            (None, true, "unset"),
            (Some("1"), true, "1"),
        ] {
            let mut command = std::process::Command::new(std::env::current_exe().unwrap());
            command.arg0("screenpipe-native-heap-test").args([
                "--exact",
                "native_allocator::tests::startup_preserves_pid_arguments_and_explicit_allocator_policy",
                "--nocapture", "--test-threads=1",
            ]).env(CHILD, expected).env_remove("MallocLargeCache")
                .env_remove(super::BOOTSTRAP_MARKER);
            if let Some(policy) = policy {
                command.env("MallocLargeCache", policy);
            }
            if marked {
                command.env(super::BOOTSTRAP_MARKER, "1");
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
                "stdout: {}\nstderr: {}",
                String::from_utf8_lossy(&result.stdout),
                String::from_utf8_lossy(&result.stderr)
            );
            assert!(String::from_utf8_lossy(&result.stdout)
                .contains(&format!("native_allocator_pid={pid}")));
        }
    }
}
