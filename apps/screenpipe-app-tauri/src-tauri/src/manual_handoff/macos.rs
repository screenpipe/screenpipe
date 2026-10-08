// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

use super::{report_failure, select, Identity, Request, Response, Selection, PROTOCOL};
use anyhow::{bail, Context, Result};
use fs2::FileExt;
use sha2::{Digest, Sha256};
use std::{
    fs::{File, OpenOptions},
    os::unix::{
        fs::{DirBuilderExt, MetadataExt, OpenOptionsExt, PermissionsExt},
        io::AsRawFd,
    },
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex, OnceLock,
    },
    time::Duration,
};
use tauri::Manager;
use tokio::{
    io::{AsyncBufReadExt, AsyncWriteExt, BufReader},
    net::{UnixListener, UnixStream},
};

#[path = "signing.rs"]
mod signing;
#[path = "kernel_signature.rs"]
mod kernel_signature;

const WAIT: Duration = Duration::from_secs(30);
const EXPECTED_BUILD_ENV: &str = "SCREENPIPE_MANUAL_HANDOFF_BUILD";
static RUNTIME: OnceLock<Runtime> = OnceLock::new();
static LAUNCH_LOCK: Mutex<Option<File>> = Mutex::new(None);
static PENDING: AtomicBool = AtomicBool::new(false);
static CAPTURE_BEFORE_HANDOFF: AtomicBool = AtomicBool::new(false);

struct Runtime {
    identity: Identity,
    requirement: String,
    socket: PathBuf,
    lock: PathBuf,
    root: PathBuf,
    executable_stamp: (u64, u64, i64, i64, u64),
}

pub(crate) fn owns_launch() -> bool {
    RUNTIME.get().is_some()
}
pub(crate) fn pending() -> bool {
    PENDING.load(Ordering::SeqCst)
}

fn manual_launch() -> bool {
    !std::env::args().any(|a| a == "--autostart" || a.contains("://"))
        && !std::env::var("XPC_SERVICE_NAME")
            .is_ok_and(|s| !s.starts_with("application.") && s.contains("screenpipe"))
}

fn private_directory(root: &Path, identifier: &str) -> Result<PathBuf> {
    let hash = Sha256::digest(format!("{}:{identifier}", root.display()).as_bytes());
    // Darwin sockaddr_un has only 104 bytes. Keep the owner-only path short.
    let digest = format!("{hash:x}");
    let directory = PathBuf::from(format!(
        "/tmp/screenpipe-handoff-{}-{}",
        unsafe { libc::geteuid() },
        &digest[..24]
    ));
    match std::fs::DirBuilder::new().mode(0o700).create(&directory) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(e) => return Err(e.into()),
    }
    let metadata = std::fs::symlink_metadata(&directory)?;
    if !metadata.is_dir()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o077 != 0
    {
        bail!("unsafe instance directory");
    }
    Ok(directory)
}

async fn acquire(path: &Path) -> Result<File> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)?;
    let start = std::time::Instant::now();
    loop {
        match file.try_lock_exclusive() {
            Ok(()) => return Ok(file),
            Err(e) if e.kind() == std::io::ErrorKind::WouldBlock && start.elapsed() < WAIT => {
                tokio::time::sleep(Duration::from_millis(100)).await
            }
            Err(e) => return Err(e).context("another app launch has not finished"),
        }
    }
}

fn peer_token(stream: &UnixStream) -> Result<[u32; 8]> {
    // The kernel audit token includes pidversion, unlike LOCAL_PEERPID. Security
    // binds signature validation to the process that connected, even after PID reuse.
    let mut token = [0u32; 8];
    let mut len = std::mem::size_of_val(&token) as libc::socklen_t;
    let result = unsafe {
        libc::getsockopt(
            stream.as_raw_fd(),
            0,     /* SOL_LOCAL */
            0x006, /* LOCAL_PEERTOKEN, sys/un.h */
            token.as_mut_ptr().cast(),
            &mut len,
        )
    };
    if result != 0 || len as usize != std::mem::size_of_val(&token) {
        bail!("could not authenticate local peer audit token");
    }
    Ok(token)
}

fn authenticated_peer(stream: &UnixStream, requirement: &str) -> Result<i32> {
    signing::verify_audit_token(&peer_token(stream)?, requirement)
}

async fn read_message<T: serde::de::DeserializeOwned>(stream: &mut UnixStream) -> Result<T> {
    let mut bytes = Vec::new();
    // A length cap prevents even a same-user local client from allocating unbounded memory.
    use tokio::io::AsyncReadExt;
    let mut reader = BufReader::new(stream.take(8193));
    tokio::time::timeout(WAIT, reader.read_until(b'\n', &mut bytes)).await??;
    if bytes.len() > 8192 || bytes.last() != Some(&b'\n') {
        bail!("invalid handoff message");
    }
    Ok(serde_json::from_slice(&bytes)?)
}

async fn write_message<T: serde::Serialize>(stream: &mut UnixStream, message: &T) -> Result<()> {
    let mut bytes = serde_json::to_vec(message)?;
    bytes.push(b'\n');
    tokio::time::timeout(WAIT, stream.write_all(&bytes)).await??;
    Ok(())
}

async fn exchange(runtime: &Runtime, replace: bool) -> Result<Option<Response>> {
    let mut stream = match UnixStream::connect(&runtime.socket).await {
        Ok(stream) => stream,
        Err(e)
            if matches!(
                e.kind(),
                std::io::ErrorKind::NotFound | std::io::ErrorKind::ConnectionRefused
            ) =>
        {
            return Ok(None)
        }
        Err(e) => return Err(e.into()),
    };
    let pid = authenticated_peer(&stream, &runtime.requirement)?;
    let stamp = signing::process_stamp(pid)?;
    let hash = signing::process_hash(pid)?;
    authenticated_peer(&stream, &runtime.requirement)?;
    write_message(
        &mut stream,
        &Request {
            protocol: PROTOCOL,
            replace,
        },
    )
    .await?;
    let response: Response = read_message(&mut stream).await?;
    if response.protocol != PROTOCOL
        || response.identity.pid != pid
        || response.identity.identifier != runtime.identity.identifier
        || (response.identity.uid, response.identity.started) != stamp
        || response.identity.hash != hash
    {
        bail!("instance identity changed during handshake");
    }
    Ok(Some(response))
}

async fn wait_for_exit(old: &Identity) -> Result<()> {
    wait_until_exit(old, WAIT).await?;
    // Match the existing updater's ScreenCaptureKit release interval.
    tokio::time::sleep(crate::process_exit::MACOS_UPDATER_RELAUNCH_SETTLE).await;
    Ok(())
}

async fn wait_until_exit(old: &Identity, timeout: Duration) -> Result<()> {
    tokio::time::timeout(timeout, async {
        while signing::process_stamp(old.pid).ok() == Some((old.uid, old.started)) {
            tokio::time::sleep(Duration::from_millis(50)).await;
        }
    })
    .await
    .context("old process did not exit; replacement was not started")?;
    Ok(())
}

pub(crate) async fn initialize() -> Result<()> {
    // Match the single-instance plugin's existing E2E isolation: those builds
    // use separate data, API, and focus ports and must not inspect another app
    // as a legacy owner merely because it has the same signing identity.
    if cfg!(feature = "e2e") {
        return Ok(());
    }
    // Bare development/test executables do not participate in production ownership.
    let executable = std::env::current_exe()?;
    if !executable.components().any(|c| c.as_os_str() == "Contents") {
        return Ok(());
    }
    let root = screenpipe_core::paths::default_screenpipe_data_dir();
    let result = initialize_inner(root.clone()).await;
    if let Err(error) = &result {
        report_failure(&root, "launch", &format!("{error:#}"));
        show_error(&format!("Screenpipe couldn't open this copy. {error:#}"));
    }
    result
}

async fn initialize_inner(root: PathBuf) -> Result<()> {
    let requirement = signing::own_requirement()?;
    let identity = signing::running(std::process::id() as i32, &requirement)?;
    let verified = signing::on_disk(&identity.executable, &requirement, &identity)?;
    if verified.hash != identity.hash || verified.identifier != identity.identifier {
        bail!("opened bundle changed during launch");
    }
    if let Ok(expected) = std::env::var(EXPECTED_BUILD_ENV) {
        std::env::remove_var(EXPECTED_BUILD_ENV);
        if expected != identity.hash {
            bail!("replacement changed after verification; launch was cancelled");
        }
    }
    let directory = private_directory(&root, &identity.identifier)?;
    let executable_stamp = file_stamp(&identity.executable)?;
    let runtime = Runtime {
        identity,
        requirement,
        socket: directory.join("ipc"),
        lock: directory.join("launch"),
        executable_stamp,
        root,
    };
    let lock = acquire(&runtime.lock).await?;
    let existing = exchange(&runtime, false).await?;
    if let Some(old) = existing {
        record_selection(&runtime, &old.identity, &runtime.identity);
        let mut replaced = false;
        if manual_launch() {
            match select(&old.identity, &runtime.identity) {
                Selection::Replace => {
                    verify_selected_bundle(&runtime)?;
                    let reply = exchange(&runtime, true)
                        .await?
                        .context("old instance disappeared before handoff")?;
                    if reply.outcome != "exiting" {
                        bail!("{}", reply.error.unwrap_or(reply.outcome));
                    }
                    wait_for_exit(&old.identity).await?;
                    replaced = true;
                }
                Selection::Reject => {
                    bail!("the opened copy is older or belongs to a different edition")
                }
                Selection::Focus => {}
            }
        }
        if !replaced {
            // A verified identical build (or background/deep-link launch) must
            // never fall through to engine initialization if focus is unavailable.
            focus_existing(&old.identity).await?;
            std::process::exit(0);
        }
    } else if manual_launch() {
        legacy_takeover(&runtime).await?;
    }
    let _ = RUNTIME.set(runtime);
    *LAUNCH_LOCK.lock().unwrap_or_else(|e| e.into_inner()) = Some(lock);
    Ok(())
}

// Revalidate the selected bundle immediately before asking the old owner to exit.
fn verify_selected_bundle(runtime: &Runtime) -> Result<()> {
    let verified = signing::on_disk(
        &runtime.identity.executable,
        &runtime.requirement,
        &runtime.identity,
    )?;
    if verified.hash != runtime.identity.hash || verified.identifier != runtime.identity.identifier
    {
        bail!("opened bundle changed during launch");
    }
    Ok(())
}

async fn focus_existing(old: &Identity) -> Result<()> {
    let port = std::env::var("SCREENPIPE_FOCUS_PORT")
        .ok()
        .and_then(|p| p.parse().ok())
        .unwrap_or(11435);
    verify_listener(old.pid, port).await?;
    let args: Vec<String> = std::env::args().collect();
    let deep_link_url = crate::deep_link::url_from_args(&args);
    let response = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(3))
        .build()?
        .post(format!("http://127.0.0.1:{port}/focus"))
        .json(&serde_json::json!({
            "args": args, "deep_link_url": deep_link_url,
            "launchd_job_label": std::env::var("XPC_SERVICE_NAME").ok(),
        }))
        .send()
        .await?;
    response
        .error_for_status()
        .context("existing app could not accept this launch")?;
    Ok(())
}

fn record_selection(runtime: &Runtime, source: &Identity, target: &Identity) {
    crate::update_diagnostics::append(
        &runtime.root,
        "manual_handoff_candidate",
        &format!(
            "source={}; target={}",
            serde_json::to_string(source).unwrap_or_default(),
            serde_json::to_string(target).unwrap_or_default()
        ),
    );
}

pub(crate) fn install(app: &tauri::AppHandle) -> Result<()> {
    let Some(runtime) = RUNTIME.get() else {
        return Ok(());
    };
    // The startup lock excludes other new builds. A stale socket has no live peer.
    if runtime.socket.exists() {
        std::fs::remove_file(&runtime.socket)?;
    }
    let listener = UnixListener::bind(&runtime.socket)?;
    std::fs::set_permissions(&runtime.socket, std::fs::Permissions::from_mode(0o600))?;
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        while let Ok((mut stream, _)) = listener.accept().await {
            let app = app.clone();
            tauri::async_runtime::spawn(async move {
                if let Err(error) = serve(&app, runtime, &mut stream).await {
                    report_failure(&runtime.root, "request", &format!("{error:#}"));
                }
            });
        }
    });
    LAUNCH_LOCK.lock().unwrap_or_else(|e| e.into_inner()).take();
    crate::update_diagnostics::append(
        &runtime.root,
        "manual_handoff_ready",
        &format!(
            "identity={}; requirement={}",
            serde_json::to_string(&runtime.identity).unwrap_or_default(),
            runtime.requirement
        ),
    );
    Ok(())
}

async fn serve(app: &tauri::AppHandle, runtime: &Runtime, stream: &mut UnixStream) -> Result<()> {
    let pid = authenticated_peer(stream, &runtime.requirement)?;
    let peer = signing::running(pid, &runtime.requirement)?;
    authenticated_peer(stream, &runtime.requirement)?;
    if peer.identifier != runtime.identity.identifier {
        bail!("different app edition");
    }
    let request: Request = read_message(stream).await?;
    if request.protocol != PROTOCOL {
        bail!("unsupported handoff protocol");
    }
    let mut response = Response {
        protocol: PROTOCOL,
        identity: runtime.identity.clone(),
        outcome: "running".into(),
        error: None,
    };
    if !request.replace {
        return write_message(stream, &response).await;
    }
    if select(&runtime.identity, &peer) != Selection::Replace {
        bail!("incoming build is not a replacement");
    }
    // Also validate all on-disk resources before the healthy owner gives up its API.
    let candidate = signing::on_disk(&peer.executable, &runtime.requirement, &peer)?;
    if candidate.hash != peer.hash {
        bail!("incoming bundle changed during launch");
    }
    record_selection(runtime, &runtime.identity, &peer);
    match prepare(app).await {
        Ok(guard) => {
            if !signing::is_same_process(&peer) {
                recover(app);
                bail!("incoming process exited before handoff");
            }
            response.outcome = "exiting".into();
            if let Err(error) = write_message(stream, &response).await {
                recover(app);
                return Err(error);
            }
            crate::update_diagnostics::append(
                &runtime.root,
                "manual_handoff_drained",
                "outcome=exiting; staged_install=suppressed",
            );
            // Keep native initialization excluded until the process is gone.
            std::mem::forget(guard);
            tokio::time::sleep(Duration::from_millis(100)).await;
            crate::process_exit::force_process_exit(0);
        }
        Err(error) => {
            response.outcome = "failed".into();
            response.error = Some(format!("{error:#}"));
            write_message(stream, &response).await?;
            Err(error)
        }
    }
}

async fn prepare(app: &tauri::AppHandle) -> Result<tokio::sync::RwLockWriteGuard<'static, ()>> {
    if PENDING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        bail!("handoff already in progress");
    }
    let mut drain_started = false;
    let result = async {
        if crate::db_recovery_notifications::recovery_active() {
            bail!("database recovery is still active");
        }
        if crate::search_only::is_entering() {
            bail!("Quit is still stopping capture; reopen this copy once Quit completes");
        }
        let guard = crate::update_restart::RESTART_SAFETY
            .prepare_restart(WAIT)
            .await
            .context("native startup did not finish")?;
        crate::store::persist_store_before_restart(app).map_err(anyhow::Error::msg)?;
        // A manual launch must not inherit the automatic updater's hidden restart marker.
        crate::search_only::prepare_manual_handoff().map_err(anyhow::Error::msg)?;
        // Opening a verified replacement is the user's restart request. Drain
        // the current recorder through its normal shutdown before releasing
        // the database, whether the UI is open or Quit left search running.
        CAPTURE_BEFORE_HANDOFF.store(
            app.state::<crate::recording::RecordingState>()
                .capture_intended(),
            Ordering::SeqCst,
        );
        drain_started = true;
        let stopping_app = app.clone();
        // A timeout must not cancel a recorder halfway through flushing its
        // durable writer. Recovery joins this task via the lifecycle lock.
        let stop = tauri::async_runtime::spawn(async move {
            crate::recording::stop_screenpipe(
                stopping_app.state::<crate::recording::RecordingState>(),
                stopping_app.clone(),
            )
            .await
        });
        let drain_started_at = std::time::Instant::now();
        // The five-second forced-exit budget is too short for an active
        // recorder (capture + durable database close took 6.5s in acceptance).
        // Use the existing IPC reply deadline instead. Exceeding it cancels
        // this replacement, but the owned stop task still finishes and the
        // previous owner recovers without abandoning pending writes.
        match wait_for_drain(stop, WAIT).await {
            crate::recording::TeardownOutcome::Completed => {}
            crate::recording::TeardownOutcome::Failed(error) => {
                bail!("recording and search shutdown failed: {error}");
            }
            crate::recording::TeardownOutcome::TimedOut => bail!(
                "recording and search shutdown still pending; elapsed_ms={}; timeout_ms={}; remaining_work=finish_shutdown_and_restore_previous_owner; replacement_cancelled=true",
                drain_started_at.elapsed().as_millis(),
                WAIT.as_millis(),
            ),
        }
        tokio::time::timeout(
            crate::recording::PRE_EXIT_TEARDOWN_TIMEOUT,
            crate::process_exit::run_pre_exit_teardown(app),
        )
        .await
        .context("remaining app shutdown timed out")?;
        Ok(guard)
    }
    .await;
    if result.is_err() {
        if drain_started {
            recover(app);
        } else {
            PENDING.store(false, Ordering::SeqCst);
        }
    }
    result
}

async fn wait_for_drain(
    stop: tauri::async_runtime::JoinHandle<Result<(), String>>,
    timeout: Duration,
) -> crate::recording::TeardownOutcome {
    crate::recording::bounded_teardown(timeout, async {
        stop.await.map_err(|error| error.to_string())?
    })
    .await
}

fn recover(app: &tauri::AppHandle) {
    app.state::<crate::recording::RecordingState>()
        .set_capture_intent(CAPTURE_BEFORE_HANDOFF.load(Ordering::SeqCst));
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let state = app.state::<crate::recording::RecordingState>();
        let _lifecycle = state.server_lifecycle.lock().await;
        crate::update_diagnostics::record(
            "manual_handoff_recovery_started",
            "outcome=restoring_previous_owner",
        );
        let result = crate::recording::spawn_screenpipe_inner(&state, app.clone()).await;
        PENDING.store(false, Ordering::SeqCst);
        match result {
            Ok(()) => crate::update_diagnostics::record(
                "manual_handoff_recovery_startup_completed",
                &format!("capture_intended={}", state.capture_intended()),
            ),
            Err(error) => {
                if let Some(runtime) = RUNTIME.get() {
                    report_failure(&runtime.root, "restore_previous_owner", &error);
                }
            }
        }
    });
}

pub(crate) fn reopen(app: &tauri::AppHandle, trigger: &'static str) -> bool {
    if pending() {
        return true;
    }
    let Some(runtime) = RUNTIME.get() else {
        return false;
    };
    if file_stamp(&runtime.identity.executable).ok() == Some(runtime.executable_stamp) {
        return false;
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let result = async {
            let _lock = acquire(&runtime.lock).await?;
            let candidate = tokio::task::spawn_blocking(move || {
                signing::on_disk(
                    &runtime.identity.executable,
                    &runtime.requirement,
                    &runtime.identity,
                )
            })
            .await??;
            crate::update_diagnostics::append(
                &runtime.root,
                "manual_handoff_reopen_candidate",
                &format!(
                    "trigger={trigger}; source={:?}; target={:?}",
                    runtime.identity, candidate
                ),
            );
            match select(&runtime.identity, &candidate) {
                Selection::Focus => {
                    let foreground = app.clone();
                    app.run_on_main_thread(move || crate::manual_reopen(&foreground))?;
                    return Ok(());
                }
                Selection::Reject => bail!("the changed bundle is not a valid replacement"),
                Selection::Replace => {}
            }
            let guard = prepare(&app).await?;
            // Launch only after the old PID exits, with no shell interpolation of paths.
            let mut command = crate::process_exit::macos_updater_relaunch_command(
                &candidate.executable,
                std::iter::empty::<&str>(),
                std::process::id(),
                crate::process_exit::MACOS_UPDATER_RELAUNCH_SETTLE,
            );
            use std::os::unix::process::CommandExt;
            command
                .process_group(0)
                .env("SCREENPIPE_DATA_DIR", &runtime.root)
                .env(EXPECTED_BUILD_ENV, &candidate.hash);
            if let Err(error) = command.spawn() {
                recover(&app);
                return Err(
                    anyhow::Error::new(error).context("could not launch replacement helper")
                );
            }
            std::mem::forget(guard);
            crate::process_exit::force_process_exit(0);
            #[allow(unreachable_code)]
            Ok::<(), anyhow::Error>(())
        }
        .await;
        if let Err(error) = result {
            report_failure(&runtime.root, trigger, &format!("{error:#}"));
            show_error(&format!(
                "Screenpipe couldn't switch to the replacement. {error:#}"
            ));
        }
    });
    true
}

fn file_stamp(path: &Path) -> Result<(u64, u64, i64, i64, u64)> {
    let m = std::fs::metadata(path)?;
    Ok((m.dev(), m.ino(), m.mtime(), m.mtime_nsec(), m.len()))
}

fn show_error(message: &str) {
    let _ = std::process::Command::new("/usr/bin/osascript")
        .args(["-e", "on run argv\ndisplay alert \"Screenpipe couldn't switch versions\" message (item 1 of argv)\nend run", "--", message]).spawn();
}

async fn legacy_takeover(runtime: &Runtime) -> Result<()> {
    let name = runtime
        .identity
        .executable
        .file_name()
        .context("missing executable name")?;
    for pid in signing::candidates(name)? {
        if let Err(error) = signing::verify_process(pid, &runtime.requirement) {
            if signing::claimed_identifier(pid).as_deref() == Some(&runtime.identity.identifier)
                || signing::process_path(pid).ok().as_ref() == Some(&runtime.identity.executable) {
                bail!("cannot authenticate the existing Screenpipe process {pid}: {error:#}");
            }
            continue;
        }
        let old = signing::running(pid, &runtime.requirement)?;
        if old.identifier != runtime.identity.identifier {
            continue;
        }
        record_selection(runtime, &old, &runtime.identity);
        match select(&old, &runtime.identity) {
            Selection::Focus => {
                focus_existing(&old).await?;
                std::process::exit(0);
            }
            Selection::Reject => bail!("the opened copy is older than the running build"),
            Selection::Replace => verify_selected_bundle(runtime)?,
        }
        let settings = crate::store::read_startup_store(&runtime.root.join("store.bin"))
            .map_err(anyhow::Error::msg)?;
        let settings = settings.get("settings").unwrap_or(&settings);
        let settings: crate::store::SettingsStore = serde_json::from_value(settings.clone())?;
        let data_dir = crate::config::selected_recording_data_dir(&settings.data_dir)?;
        let mut api = crate::recording::LocalApiContext {
            port: std::env::var("SCREENPIPE_PORT")
                .ok()
                .and_then(|p| p.parse().ok())
                .unwrap_or(settings.recording.port),
            api_key: std::env::var("SCREENPIPE_API_KEY")
                .ok()
                .filter(|k| !k.is_empty())
                .or_else(|| {
                    (!settings.recording.api_key.is_empty()).then_some(settings.recording.api_key)
                }),
        };
        if api.api_key.is_none() {
            api.api_key =
                screenpipe_engine::auth_key::find_api_auth_key_for_data_dir(&data_dir).await;
        }
        if api.api_key.is_none() {
            bail!("cannot authenticate the legacy search API without its existing key");
        }
        verify_listener(pid, api.port).await?;
        verify_legacy_stopped(&api).await?;
        // Recheck both immediately before targeting the exact process. Never kill by name/port.
        verify_listener(pid, api.port).await?;
        verify_legacy_stopped(&api).await?;
        if !signing::is_same_process(&old) {
            bail!("legacy process changed before termination");
        }
        if unsafe { libc::kill(old.pid, libc::SIGTERM) } != 0 {
            return Err(std::io::Error::last_os_error()).context("legacy termination failed");
        }
        wait_for_exit(&old).await?;
        crate::update_diagnostics::append(
            &runtime.root,
            "manual_handoff_legacy_exited",
            "outcome=selected_copy_starting; capture=stopped",
        );
    }
    Ok(())
}

async fn verify_listener(pid: i32, port: u16) -> Result<()> {
    let output = tokio::time::timeout(
        Duration::from_secs(3),
        tokio::process::Command::new("/usr/sbin/lsof")
            .args([
                "-nP",
                "-a",
                "-p",
                &pid.to_string(),
                &format!("-iTCP:{port}"),
                "-sTCP:LISTEN",
                "-t",
            ])
            .output(),
    )
    .await??;
    if !output.status.success() || String::from_utf8_lossy(&output.stdout).trim() != pid.to_string()
    {
        bail!("legacy API listener does not belong to the verified app");
    }
    Ok(())
}

async fn verify_legacy_stopped(api: &crate::recording::LocalApiContext) -> Result<()> {
    let client = reqwest::Client::builder()
        .no_proxy()
        .timeout(Duration::from_secs(3))
        .build()?;
    let unauthenticated = client.get(api.url("/pipes")).send().await?;
    if !matches!(unauthenticated.status().as_u16(), 401 | 403) {
        bail!("legacy API does not enforce authentication; cannot verify search-only ownership");
    }
    // This read-only route is blocked by the shipped search-only middleware.
    let response = api.apply_auth(client.get(api.url("/pipes"))).send().await?;
    if response.status() != reqwest::StatusCode::CONFLICT
        || response.json::<serde_json::Value>().await?["error"] != "search_only"
    {
        bail!("legacy app is not in search-only mode");
    }
    for (route, field) in [
        ("/audio/device/status", "is_running"),
        ("/vision/device/status", "active"),
    ] {
        let response = api
            .apply_auth(client.get(api.url(route)))
            .send()
            .await?
            .error_for_status()?
            .json::<serde_json::Value>()
            .await?;
        let devices = response
            .as_array()
            .context("capture status is unavailable")?;
        if devices.iter().any(|d| d[field].as_bool() != Some(false)) {
            bail!("legacy capture has not stopped");
        }
    }
    let health = api
        .apply_auth(client.get(api.url("/health")))
        .send()
        .await?
        .error_for_status()?
        .json::<serde_json::Value>()
        .await?;
    if health["ui_recorder"]["running"].as_bool() != Some(false) {
        bail!("legacy UI capture has not been verified stopped");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn completed_drain_and_originating_failure_reach_handoff() {
        use crate::recording::TeardownOutcome;
        let stop = tauri::async_runtime::spawn(async { Ok(()) });
        assert_eq!(wait_for_drain(stop, WAIT).await, TeardownOutcome::Completed);
        let stop = tauri::async_runtime::spawn(async { Err("writer flush failed".into()) });
        assert_eq!(
            wait_for_drain(stop, WAIT).await,
            TeardownOutcome::Failed("writer flush failed".into())
        );
    }

    #[tokio::test]
    async fn drain_deadline_retains_flush_and_excludes_recovery_until_it_finishes() {
        use crate::recording::TeardownOutcome;
        use std::sync::Arc;
        let lifecycle = Arc::new(tokio::sync::Mutex::new(()));
        let guard = lifecycle.clone().lock_owned().await;
        let (finish, pending_write) = tokio::sync::oneshot::channel();
        let flushed = Arc::new(AtomicBool::new(false));
        let task_flushed = flushed.clone();
        let stop = tauri::async_runtime::spawn(async move {
            let _guard = guard;
            pending_write.await.map_err(|error| error.to_string())?;
            task_flushed.store(true, Ordering::SeqCst);
            Ok(())
        });
        // At the deadline, unfinished work remains owned by the stop task.
        assert_eq!(
            wait_for_drain(stop, Duration::ZERO).await,
            TeardownOutcome::TimedOut
        );
        assert!(lifecycle.try_lock().is_err());
        assert!(!flushed.load(Ordering::SeqCst));
        // Completion after the deadline still flushes before recovery can
        // acquire the same lifecycle lock and reopen the database.
        finish.send(()).unwrap();
        let _recovery = lifecycle.lock().await;
        assert!(flushed.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn socket_uses_os_peer_and_rejects_supplied_pid() {
        let (mut left, right) = UnixStream::pair().unwrap();
        let requirement = signing::own_requirement().unwrap();
        assert_eq!(
            authenticated_peer(&right, &requirement).unwrap(),
            std::process::id() as i32
        );
        left.write_all(b"{\"protocol\":1,\"replace\":true,\"pid\":1}\n")
            .await
            .unwrap();
        let mut right = right;
        assert!(read_message::<Request>(&mut right).await.is_err());
    }

    #[tokio::test]
    async fn stale_peer_process_generation_is_rejected() {
        let (_left, right) = UnixStream::pair().unwrap();
        let mut token = peer_token(&right).unwrap();
        token[7] = token[7].wrapping_add(1);
        assert!(signing::verify_audit_token(&token, &signing::own_requirement().unwrap()).is_err());
    }

    #[tokio::test]
    async fn oversized_request_is_rejected() {
        let (mut left, mut right) = UnixStream::pair().unwrap();
        let writer = tokio::spawn(async move { left.write_all(&vec![b'x'; 8193]).await });
        assert!(read_message::<Request>(&mut right).await.is_err());
        writer.await.unwrap().unwrap();
    }

    #[tokio::test]
    async fn concurrent_launches_cannot_hold_the_same_lease() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("launch");
        let first = acquire(&path).await.unwrap();
        let second = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&path)
            .unwrap();
        assert_eq!(
            second.try_lock_exclusive().unwrap_err().kind(),
            std::io::ErrorKind::WouldBlock
        );
        drop(first);
        drop(second);
        // Other tests spawn processes. A fork can briefly inherit the locked
        // descriptor until exec closes it; the production lease retries this.
        let _next = acquire(&path).await.unwrap();
    }

    #[tokio::test]
    async fn live_owner_timeout_never_counts_as_exit() {
        let pid = std::process::id() as i32;
        let (uid, started) = signing::process_stamp(pid).unwrap();
        let mut old = Identity {
            pid,
            uid,
            started,
            identifier: "test".into(),
            version: "1.0.0".into(),
            hash: "unused".into(),
            executable: "test".into(),
        };
        assert!(wait_until_exit(&old, Duration::from_millis(5))
            .await
            .is_err());
        old.started -= 1;
        // PID reuse is not the old process surviving.
        wait_until_exit(&old, Duration::from_millis(5))
            .await
            .unwrap();
    }

    #[test]
    fn same_path_replacement_changes_file_stamp() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("app");
        std::fs::write(&path, "old").unwrap();
        let before = file_stamp(&path).unwrap();
        let replacement = dir.path().join("new");
        std::fs::write(&replacement, "new").unwrap();
        std::fs::rename(&replacement, &path).unwrap();
        assert_ne!(before, file_stamp(&path).unwrap());
    }

    #[tokio::test]
    async fn legacy_takeover_requires_authenticated_search_only_and_stopped_devices() {
        use axum::{routing::get, Json, Router};
        use serde_json::json;
        use std::sync::Arc;
        let active = Arc::new(AtomicBool::new(false));
        let audio_active = active.clone();
        let router =
            Router::new()
                .route(
                    "/pipes",
                    get(|headers: axum::http::HeaderMap| async move {
                        if headers.get("authorization").and_then(|v| v.to_str().ok())
                            == Some("Bearer handoff-test")
                        {
                            (
                                axum::http::StatusCode::CONFLICT,
                                Json(json!({"error":"search_only"})),
                            )
                        } else {
                            (
                                axum::http::StatusCode::UNAUTHORIZED,
                                Json(json!({"error":"unauthorized"})),
                            )
                        }
                    }),
                )
                .route(
                    "/audio/device/status",
                    get(move || {
                        let audio_active = audio_active.clone();
                        async move {
                            Json(json!([{ "is_running": audio_active.load(Ordering::SeqCst) }]))
                        }
                    }),
                )
                .route(
                    "/vision/device/status",
                    get(|| async { Json(json!([{ "active":false }])) }),
                )
                .route(
                    "/health",
                    get(|| async { Json(json!({ "ui_recorder": {"running":false} })) }),
                );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let port = listener.local_addr().unwrap().port();
        let listener = listener.into_std().unwrap();
        let server = tokio::spawn(async move {
            axum::Server::from_tcp(listener)
                .unwrap()
                .serve(router.into_make_service())
                .await
                .unwrap()
        });
        let mut api = crate::recording::LocalApiContext {
            port,
            api_key: Some("handoff-test".into()),
        };
        verify_legacy_stopped(&api).await.unwrap();
        active.store(true, Ordering::SeqCst);
        assert!(verify_legacy_stopped(&api)
            .await
            .unwrap_err()
            .to_string()
            .contains("capture has not stopped"));
        active.store(false, Ordering::SeqCst);
        api.api_key = Some("wrong-key".into());
        assert!(verify_legacy_stopped(&api).await.is_err());
        server.abort();
    }
}
