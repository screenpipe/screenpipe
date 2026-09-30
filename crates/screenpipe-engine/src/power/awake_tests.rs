// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

// Live coverage: cargo test -p screenpipe-engine --lib power::awake::tests
// --features zbus/tokio -- --include-ignored. Explicitly enable Tokio so
// feature-unification changes cannot hide the original nested-runtime panic.
// Live tests require logind; default tests use isolated child processes and
// cover missing/stalled buses without privileges.

use super::{set_keep_awake, set_keep_awake_async, KeepAwakeGuard};
use std::sync::{Arc, Barrier, Mutex};
use std::time::{Duration, Instant};

// Live tests share the process-wide setting. Serialize them and always release
// it, including on assertion failure. Other Screenpipe processes are excluded.
static LIVE_TEST: Mutex<()> = Mutex::new(());

fn with_logind(test: impl FnOnce()) {
    let _serial = LIVE_TEST.lock().unwrap_or_else(|e| e.into_inner());
    struct Reset;
    impl Drop for Reset {
        fn drop(&mut self) {
            set_keep_awake(false).expect("release test setting");
        }
    }
    let _reset = Reset;
    expect_inhibitors(0);
    test();
    expect_inhibitors(0);
}

fn expect_inhibitors(expected: usize) {
    // Also safe when called inside a Tokio test, without masking acquisition
    // bugs in the production API under test.
    std::thread::spawn(move || {
        let connection = zbus::blocking::Connection::system().unwrap();
        let proxy = zbus::blocking::Proxy::new(
            &connection,
            "org.freedesktop.login1",
            "/org/freedesktop/login1",
            "org.freedesktop.login1.Manager",
        )
        .unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            let locks: Vec<(String, String, String, String, u32, u32)> =
                proxy.call("ListInhibitors", &()).unwrap();
            let ours: Vec<_> = locks
                .iter()
                .filter(|lock| lock.1 == "screenpipe" && lock.5 == std::process::id())
                .collect();
            for lock in &ours {
                assert_eq!(lock.0, "sleep:idle");
                assert_eq!(lock.3, "block");
            }
            if ours.len() == expected {
                return;
            }
            assert!(
                Instant::now() < deadline,
                "expected {expected} inhibitors, got {ours:?}"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    })
    .join()
    .unwrap();
}

#[test]
#[ignore = "requires a real system bus and permission to inhibit logind"]
fn sync_lifetime_and_independent_setting() {
    with_logind(|| {
        let migration = KeepAwakeGuard::acquire().expect("acquire migration lock");
        let recovery = KeepAwakeGuard::acquire().expect("acquire recovery lock");
        expect_inhibitors(2);
        for _ in 0..3 {
            set_keep_awake(true).unwrap();
            set_keep_awake(true).unwrap();
            expect_inhibitors(3);
            set_keep_awake(false).unwrap();
            set_keep_awake(false).unwrap();
            expect_inhibitors(2);
        }
        drop(migration);
        expect_inhibitors(1);
        drop(recovery);
    });
}

fn runtime_lifetime(runtime: tokio::runtime::Runtime) {
    with_logind(|| {
        let guard = runtime.block_on(async {
            set_keep_awake_async(true).await.unwrap();
            let guard = KeepAwakeGuard::acquire_async()
                .await
                .expect("acquire from Tokio");
            expect_inhibitors(2);
            set_keep_awake_async(false).await.unwrap();
            guard
        });
        drop(runtime);
        // logind owns the lifetime through the FD, not the worker or runtime.
        expect_inhibitors(1);
        drop(guard);
    });
}

#[test]
#[ignore = "requires a real system bus and permission to inhibit logind"]
fn current_thread_runtime_and_shutdown() {
    runtime_lifetime(
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap(),
    );
}

#[test]
#[ignore = "requires a real system bus and permission to inhibit logind"]
fn multi_thread_runtime_and_shutdown() {
    runtime_lifetime(
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap(),
    );
}

#[test]
#[ignore = "requires a real system bus and permission to inhibit logind"]
fn concurrent_acquisitions_release_independently() {
    with_logind(|| {
        let ready = Arc::new(Barrier::new(5));
        let release = Arc::new(Barrier::new(5));
        let workers: Vec<_> = (0..4)
            .map(|_| {
                let ready = ready.clone();
                let release = release.clone();
                std::thread::spawn(move || {
                    let setting = set_keep_awake(true);
                    let guard = KeepAwakeGuard::acquire();
                    ready.wait();
                    release.wait();
                    setting.expect("concurrent setting");
                    drop(guard.expect("concurrent acquisition"));
                })
            })
            .collect();
        ready.wait();
        // Release the workers even if the assertion fails.
        let observed = std::panic::catch_unwind(|| expect_inhibitors(5));
        release.wait();
        for worker in workers {
            worker.join().unwrap();
        }
        observed.unwrap();
        expect_inhibitors(1);
        set_keep_awake(false).unwrap();
    });
}

#[test]
#[ignore = "requires a real system bus and permission to inhibit logind"]
fn cancelled_task_releases_only_its_lock() {
    with_logind(|| {
        let independent = KeepAwakeGuard::acquire().unwrap();
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        runtime.block_on(async {
            let (ready, acquired) = tokio::sync::oneshot::channel();
            let task = tokio::spawn(async move {
                let _guard = KeepAwakeGuard::acquire_async().await.unwrap();
                ready.send(()).unwrap();
                std::future::pending::<()>().await;
            });
            acquired.await.unwrap();
            expect_inhibitors(2);
            task.abort();
            assert!(task.await.unwrap_err().is_cancelled());
        });
        expect_inhibitors(1);
        drop(independent);
    });
}

#[test]
#[ignore = "requires a real system bus and permission to inhibit logind"]
fn unwinding_releases_only_its_lock() {
    with_logind(|| {
        let independent = KeepAwakeGuard::acquire().unwrap();
        let result = std::panic::catch_unwind(|| {
            let _guard = KeepAwakeGuard::acquire().unwrap();
            expect_inhibitors(2);
            panic!("simulated caller failure");
        });
        assert!(result.is_err());
        expect_inhibitors(1);
        drop(independent);
    });
}

#[test]
fn unavailable_bus_returns_errors_without_poisoning_state() {
    // Change the bus address only in a child: process-global env mutation would
    // race with the live tests and any other D-Bus users in the test process.
    let module = module_path!().split_once("::").unwrap().1;
    let output = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            &format!("{module}::unavailable_bus_child"),
            "--ignored",
            "--nocapture",
        ])
        .env("SCREENPIPE_AWAKE_FAILURE_TEST", "1")
        .env(
            "DBUS_SYSTEM_BUS_ADDRESS",
            "unix:path=/dev/null/screenpipe-no-bus",
        )
        .output()
        .unwrap();
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed"));
}

#[test]
#[ignore = "child process only; started by unavailable_bus_returns_errors_without_poisoning_state"]
fn unavailable_bus_child() {
    if std::env::var("SCREENPIPE_AWAKE_FAILURE_TEST").as_deref() != Ok("1") {
        return;
    }
    fn exercise() {
        for _ in 0..3 {
            let error = KeepAwakeGuard::acquire()
                .err()
                .expect("bus must be unavailable");
            assert!(error.starts_with("D-Bus system bus:"), "{error}");
            let error = set_keep_awake(true).unwrap_err();
            assert!(error.starts_with("D-Bus system bus:"), "{error}");
            set_keep_awake(false).expect("failure must not poison the settings mutex");
        }
    }
    exercise();
    for runtime in [
        tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap(),
        tokio::runtime::Builder::new_multi_thread()
            .worker_threads(2)
            .enable_all()
            .build()
            .unwrap(),
    ] {
        runtime.block_on(async {
            exercise();
            let error = KeepAwakeGuard::acquire_async()
                .await
                .err()
                .expect("missing bus");
            assert!(error.starts_with("D-Bus system bus:"), "{error}");
            assert!(set_keep_awake_async(true).await.is_err());
            set_keep_awake_async(false).await.unwrap();
        });
    }
}

#[test]
fn stalled_bus_has_bounded_wait_and_allows_cancellation() {
    use std::io::Read;
    use std::os::unix::net::UnixListener;
    use std::sync::atomic::{AtomicBool, Ordering};
    let path = std::env::temp_dir().join(format!(
        "screenpipe-stalled-bus-{}.sock",
        std::process::id()
    ));
    let listener = UnixListener::bind(&path).unwrap();
    listener.set_nonblocking(true).unwrap();
    let stop = Arc::new(AtomicBool::new(false));
    let stopped = stop.clone();
    let server = std::thread::spawn(move || {
        let mut connections = Vec::new();
        while !stopped.load(Ordering::SeqCst) {
            if let Ok((stream, _)) = listener.accept() {
                stream.set_nonblocking(true).unwrap();
                connections.push(stream);
            }
            // Accept authentication bytes but deliberately never answer.
            connections.retain_mut(|stream| {
                let mut bytes = [0; 256];
                !matches!(stream.read(&mut bytes), Ok(0))
            });
            std::thread::sleep(Duration::from_millis(5));
        }
    });
    let module = module_path!().split_once("::").unwrap().1;
    let mut child = std::process::Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            &format!("{module}::stalled_bus_child"),
            "--ignored",
            "--nocapture",
        ])
        .env("SCREENPIPE_AWAKE_STALL_TEST", "1")
        .env(
            "DBUS_SYSTEM_BUS_ADDRESS",
            format!("unix:path={}", path.display()),
        )
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(25);
    while child.try_wait().unwrap().is_none() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(20));
    }
    let timed_out = child.try_wait().unwrap().is_none();
    if timed_out {
        child.kill().unwrap();
    }
    let output = child.wait_with_output().unwrap();
    stop.store(true, Ordering::SeqCst);
    server.join().unwrap();
    std::fs::remove_file(path).unwrap();
    assert!(
        !timed_out,
        "wake lock blocked the test process beyond its deadline"
    );
    assert!(
        output.status.success(),
        "{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(String::from_utf8_lossy(&output.stdout).contains("1 passed"));
}

#[test]
#[ignore = "child process only; started by stalled_bus_has_bounded_wait_and_allows_cancellation"]
fn stalled_bus_child() {
    use std::sync::atomic::{AtomicUsize, Ordering};
    if std::env::var("SCREENPIPE_AWAKE_STALL_TEST").as_deref() != Ok("1") {
        return;
    }
    let start = Instant::now();
    let error = KeepAwakeGuard::acquire()
        .err()
        .expect("stalled bus must time out");
    assert!(error.contains("timed out"), "{error}");
    assert!(start.elapsed() < Duration::from_secs(7));
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap();
    runtime.block_on(async {
        let beats = Arc::new(AtomicUsize::new(0));
        let ticks = beats.clone();
        let heartbeat = tokio::spawn(async move {
            loop {
                ticks.fetch_add(1, Ordering::SeqCst);
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        });
        let error = KeepAwakeGuard::acquire_async()
            .await
            .err()
            .expect("stalled bus must time out");
        assert!(error.contains("timed out"), "{error}");
        assert!(
            beats.load(Ordering::SeqCst) > 10,
            "acquisition blocked Tokio"
        );
        let pending = tokio::spawn(KeepAwakeGuard::acquire_async());
        tokio::time::sleep(Duration::from_millis(50)).await;
        pending.abort();
        let result = tokio::time::timeout(Duration::from_secs(1), pending)
            .await
            .expect("cancellation stalled");
        assert!(matches!(result, Err(error) if error.is_cancelled()));
        let before = beats.load(Ordering::SeqCst);
        let error = set_keep_awake_async(true).await.unwrap_err();
        assert!(error.contains("timed out"), "{error}");
        assert!(
            beats.load(Ordering::SeqCst) > before + 10,
            "setting blocked Tokio"
        );
        set_keep_awake_async(false).await.unwrap();
        heartbeat.abort();
    });
}
