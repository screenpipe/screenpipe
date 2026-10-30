// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Windows Enterprise takes priority over a consumer instance at the shared
//! control port. This runs before Tauri or the embedded database is opened.

use std::io::{Read, Seek, SeekFrom, Write};
use std::os::windows::ffi::OsStrExt;
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

use sysinfo::{Pid, PidExt, ProcessExt, System, SystemExt};

pub(crate) const LOG_NAME: &str = "enterprise-takeover.log";
const MAX_LOG_BYTES: u64 = 32 * 1024;
const CREATE_NO_WINDOW: u32 = 0x08000000;
const ENTERPRISE_PRODUCT_NAME: &str = "screenpipe enterprise";
static LOG_WRITER: Mutex<()> = Mutex::new(());
static ENTERPRISE_PRESENCE: OnceLock<OwnedHandle> = OnceLock::new();

fn presence_name(control_port: u16, api_port: u16) -> String {
    // Local objects are scoped to the interactive Windows session. Including
    // the already-isolated ports keeps debug and E2E launches independent from
    // installed production instances without trusting an installation path.
    format!(r"Local\ScreenpipeEnterprise-{control_port}-{api_port}")
}

/// Publish authoritative Enterprise build identity before any app state opens.
/// The kernel releases the marker when the process truly exits, including on a
/// crash, so Consumer cannot mistake a stale file or unhealthy HTTP endpoint
/// for a live Enterprise instance.
pub(crate) fn publish_enterprise_presence(control_port: u16, api_port: u16) -> Result<(), String> {
    use windows::core::HSTRING;
    use windows::Win32::System::Threading::CreateMutexW;

    if ENTERPRISE_PRESENCE.get().is_some() {
        return Ok(());
    }
    let name = HSTRING::from(presence_name(control_port, api_port));
    let handle = unsafe { CreateMutexW(None, false, &name) }.map_err(|error| {
        let cause = format!("could not publish Enterprise presence: {error}");
        record(
            "presence_publish_failed",
            &cause,
            "enterprise_start_aborted",
        );
        cause
    })?;
    // SAFETY: CreateMutexW returned an owned kernel handle, transferred once.
    let handle = unsafe { OwnedHandle::from_raw_handle(handle.0 as *mut _) };
    let _ = ENTERPRISE_PRESENCE.set(handle);
    Ok(())
}

/// Consumer must stop while the Enterprise build owns its session marker.
pub(crate) async fn enterprise_is_present(
    control_port: u16,
    api_port: u16,
) -> Result<bool, String> {
    use windows::core::HSTRING;
    use windows::Win32::Foundation::ERROR_FILE_NOT_FOUND;
    use windows::Win32::System::Threading::{OpenMutexW, SYNCHRONIZATION_ACCESS_RIGHTS};

    let name = HSTRING::from(presence_name(control_port, api_port));
    match unsafe { OpenMutexW(SYNCHRONIZATION_ACCESS_RIGHTS(0x0010_0000), false, &name) } {
        Ok(handle) => {
            // SAFETY: OpenMutexW returned an owned kernel handle, closed here.
            drop(unsafe { OwnedHandle::from_raw_handle(handle.0 as *mut _) });
            record(
                "consumer_blocked",
                &format!(
                    "Enterprise presence verified for control_port={control_port} api_port={api_port}"
                ),
                "consumer_start_aborted",
            );
            return Ok(true);
        }
        Err(error) if error.code() == ERROR_FILE_NOT_FOUND.to_hresult() => {}
        Err(error) => {
            let cause = format!("could not inspect Enterprise presence: {error}");
            record("presence_check_failed", &cause, "consumer_start_aborted");
            return Err(cause);
        }
    }

    for port in [control_port, api_port] {
        let Some(pid) = listening_pid(port).await.map_err(|error| {
            let cause = format!("could not inspect legacy Enterprise owner: {error}");
            record(
                "legacy_presence_check_failed",
                &cause,
                "consumer_start_aborted",
            );
            cause
        })?
        else {
            continue;
        };
        if pid == std::process::id() {
            continue;
        }
        let same_session = is_current_session(pid).map_err(|error| {
            let cause = format!("could not inspect legacy Enterprise owner session: {error}");
            record(
                "legacy_presence_check_failed",
                &cause,
                "consumer_start_aborted",
            );
            cause
        })?;
        if !same_session {
            continue;
        }
        let exe = process_executable(pid).map_err(|error| {
            let cause = format!("could not identify legacy Enterprise owner: {error}");
            record(
                "legacy_presence_check_failed",
                &cause,
                "consumer_start_aborted",
            );
            cause
        })?;
        if !looks_like_screenpipe_exe(&exe) {
            continue;
        }
        let product_name = executable_product_name(&exe).map_err(|error| {
            let cause = format!("could not inspect legacy Enterprise metadata: {error}");
            record(
                "legacy_presence_check_failed",
                &cause,
                "consumer_start_aborted",
            );
            cause
        })?;
        if product_name.is_some_and(|name| name.eq_ignore_ascii_case(ENTERPRISE_PRODUCT_NAME)) {
            record(
                "consumer_blocked",
                &format!("legacy Enterprise ProductName verified for pid={pid} port={port}"),
                "consumer_start_aborted",
            );
            return Ok(true);
        }
    }
    Ok(false)
}

fn process_executable(pid: u32) -> Result<PathBuf, String> {
    use windows::core::PWSTR;
    use windows::Win32::System::Threading::{
        OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_FORMAT,
        PROCESS_QUERY_LIMITED_INFORMATION,
    };

    let process = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }
        .map_err(|error| format!("could not open owner pid={pid}: {error}"))?;
    // SAFETY: OpenProcess returned an owned kernel handle, transferred once.
    let process = unsafe { OwnedHandle::from_raw_handle(process.0 as *mut _) };
    let mut path = vec![0u16; 32_768];
    let mut length = path.len() as u32;
    unsafe {
        QueryFullProcessImageNameW(
            windows::Win32::Foundation::HANDLE(process.as_raw_handle()),
            PROCESS_NAME_FORMAT(0),
            PWSTR(path.as_mut_ptr()),
            &mut length,
        )
        .map_err(|error| format!("could not query owner pid={pid} executable: {error}"))?;
    }
    path.truncate(length as usize);
    Ok(PathBuf::from(String::from_utf16(&path).map_err(
        |error| format!("owner pid={pid} returned an invalid executable path: {error}"),
    )?))
}

fn executable_product_name(path: &Path) -> Result<Option<String>, String> {
    if let Some(product_name) = crate::package_identity::product_name_for(path)? {
        return Ok(Some(product_name));
    }

    use std::ffi::c_void;

    #[link(name = "version")]
    extern "system" {
        fn GetFileVersionInfoSizeW(filename: *const u16, handle: *mut u32) -> u32;
        fn GetFileVersionInfoW(
            filename: *const u16,
            handle: u32,
            length: u32,
            data: *mut c_void,
        ) -> i32;
        fn VerQueryValueW(
            block: *const c_void,
            sub_block: *const u16,
            buffer: *mut *mut c_void,
            length: *mut u32,
        ) -> i32;
    }

    let path_wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let size = unsafe { GetFileVersionInfoSizeW(path_wide.as_ptr(), std::ptr::null_mut()) };
    if size == 0 {
        let error = std::io::Error::last_os_error();
        if matches!(error.raw_os_error(), Some(1812..=1815)) {
            return Ok(None);
        }
        return Err(format!(
            "{} has no readable PE version resource: {}",
            path.display(),
            error
        ));
    }
    let mut data = vec![0u8; size as usize];
    unsafe {
        if GetFileVersionInfoW(
            path_wide.as_ptr(),
            0,
            size,
            data.as_mut_ptr().cast::<c_void>(),
        ) == 0
        {
            return Err(format!(
                "could not read {}: {}",
                path.display(),
                std::io::Error::last_os_error()
            ));
        }
    }

    let translation_query: Vec<u16> = "\\VarFileInfo\\Translation\0".encode_utf16().collect();
    let mut translation = std::ptr::null_mut::<c_void>();
    let mut translation_len = 0u32;
    unsafe {
        if VerQueryValueW(
            data.as_ptr().cast::<c_void>(),
            translation_query.as_ptr(),
            &mut translation,
            &mut translation_len,
        ) == 0
        {
            return Ok(None);
        }
    }
    if translation_len < 4 || translation.is_null() {
        return Err(format!(
            "{} has an invalid PE translation table",
            path.display()
        ));
    }
    let translation = unsafe { std::slice::from_raw_parts(translation.cast::<u16>(), 2) };
    let product_query = format!(
        "\\StringFileInfo\\{:04x}{:04x}\\ProductName\0",
        translation[0], translation[1]
    );
    let product_query: Vec<u16> = product_query.encode_utf16().collect();
    let mut product = std::ptr::null_mut::<c_void>();
    let mut product_len = 0u32;
    unsafe {
        if VerQueryValueW(
            data.as_ptr().cast::<c_void>(),
            product_query.as_ptr(),
            &mut product,
            &mut product_len,
        ) == 0
        {
            return Ok(None);
        }
    }
    if product_len == 0 || product.is_null() {
        return Ok(None);
    }
    let product = unsafe {
        std::slice::from_raw_parts(
            product.cast::<u16>(),
            product_len.saturating_sub(1) as usize,
        )
    };
    String::from_utf16(product)
        .map(Some)
        .map_err(|error| format!("{} has an invalid ProductName: {error}", path.display()))
}

pub(crate) fn is_takeover_log(name: &str) -> bool {
    name == LOG_NAME
        || name
            .strip_prefix("enterprise-takeover.")
            .and_then(|suffix| suffix.strip_suffix(".log"))
            .is_some_and(|rotation| {
                !rotation.is_empty()
                    && rotation
                        .bytes()
                        .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
            })
}

#[derive(Debug)]
struct Owner {
    pid: u32,
    exe: PathBuf,
    process: OwnedHandle,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub(crate) enum TakeoverOutcome {
    NoOwner,
    SameExecutable,
    ReplacedCompetingOwner,
}

pub(crate) async fn take_over_screenpipe_owners(
    control_port: u16,
    api_port: u16,
) -> Result<TakeoverOutcome, String> {
    let mut saw_same_executable = false;
    let mut replaced_competing_owner = false;

    for port in [control_port, api_port] {
        match take_over_screenpipe_owner(port).await? {
            TakeoverOutcome::NoOwner => {}
            TakeoverOutcome::SameExecutable => saw_same_executable = true,
            TakeoverOutcome::ReplacedCompetingOwner => replaced_competing_owner = true,
        }
    }

    if saw_same_executable {
        Ok(TakeoverOutcome::SameExecutable)
    } else if replaced_competing_owner {
        Ok(TakeoverOutcome::ReplacedCompetingOwner)
    } else {
        Ok(TakeoverOutcome::NoOwner)
    }
}

pub(crate) async fn take_over_screenpipe_owner(port: u16) -> Result<TakeoverOutcome, String> {
    let Some(owner) = resolve_verified_owner(port).await.map_err(|cause| {
        record("verification_failed", &cause, "enterprise_start_aborted");
        cause
    })?
    else {
        return Ok(TakeoverOutcome::NoOwner);
    };

    let current_exe = std::env::current_exe()
        .map_err(|error| format!("could not resolve Enterprise executable: {error}"))?;
    if same_path(&owner.exe, &current_exe) {
        return Ok(TakeoverOutcome::SameExecutable);
    }

    record(
        "verified_competing_screenpipe",
        &format!("pid={} port={port}", owner.pid),
        "termination_started",
    );

    if let Err(cause) = run_taskkill(owner.pid, false).await {
        record(
            "graceful_termination_failed",
            &format!("pid={} Windows cause: {cause}", owner.pid),
            "force_fallback_required",
        );
    }

    if wait_for_owner_exit(&owner, port, Duration::from_secs(8)).await {
        record(
            "takeover_complete",
            &format!("pid={} port={port} graceful=true", owner.pid),
            "enterprise_start_allowed",
        );
        return Ok(TakeoverOutcome::ReplacedCompetingOwner);
    }

    match process_state(&owner)? {
        ProcessState::Alive => {}
        ProcessState::Exited => {
            let detail = format!(
                "pid={} exited but control port {port} remained occupied",
                owner.pid
            );
            record("termination_failed", &detail, "enterprise_start_aborted");
            return Err(detail);
        }
    }
    run_taskkill(owner.pid, true).await.map_err(|cause| {
        let detail = format!("pid={} forced termination failed: {cause}", owner.pid);
        record("termination_failed", &detail, "enterprise_start_aborted");
        detail
    })?;

    if !wait_for_owner_exit(&owner, port, Duration::from_secs(8)).await {
        let detail = format!(
            "pid={} port={port} remained alive or retained control ownership after timeout",
            owner.pid
        );
        record("termination_timeout", &detail, "enterprise_start_aborted");
        return Err(detail);
    }

    record(
        "takeover_complete",
        &format!("pid={} port={port} graceful=false", owner.pid),
        "enterprise_start_allowed",
    );
    Ok(TakeoverOutcome::ReplacedCompetingOwner)
}

async fn resolve_verified_owner(port: u16) -> Result<Option<Owner>, String> {
    let Some(pid) = listening_pid(port).await? else {
        return Ok(None);
    };
    if pid == std::process::id() {
        return Err("control owner resolved to the launching Enterprise process".into());
    }

    let mut system = System::new();
    let sys_pid = Pid::from_u32(pid);
    system.refresh_process(sys_pid);
    let process = system
        .process(sys_pid)
        .ok_or_else(|| format!("control owner pid={pid} exited before verification"))?;
    let exe = process.exe().to_path_buf();
    let start_time = process.start_time();
    #[cfg(test)]
    let is_current_test_harness =
        std::env::current_exe().is_ok_and(|current_exe| same_path(&exe, &current_exe));
    #[cfg(not(test))]
    let is_current_test_harness = false;
    if !looks_like_screenpipe_exe(&exe) && !is_current_test_harness {
        return Err(format!(
            "refused to terminate pid={pid}: verified control responder executable was not Screenpipe ({})",
            exe.display()
        ));
    }
    verify_current_session(pid)?;
    let process_handle = open_process_for_wait(pid)?;
    system.refresh_process(sys_pid);
    let process = system
        .process(sys_pid)
        .ok_or_else(|| format!("control owner pid={pid} exited while opening its wait handle"))?;
    if process.start_time() != start_time || !same_path(process.exe(), &exe) {
        return Err(format!(
            "control owner pid={pid} changed identity while opening its wait handle"
        ));
    }

    Ok(Some(Owner {
        pid,
        exe,
        process: process_handle,
    }))
}

fn open_process_for_wait(pid: u32) -> Result<OwnedHandle, String> {
    use windows::Win32::System::Threading::{
        OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION, PROCESS_SYNCHRONIZE,
    };
    let handle = unsafe {
        OpenProcess(
            PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_SYNCHRONIZE,
            false,
            pid,
        )
    }
    .map_err(|error| format!("could not open pid={pid} for stable exit wait: {error}"))?;
    // SAFETY: OpenProcess returned an owned kernel handle, transferred exactly once.
    Ok(unsafe { OwnedHandle::from_raw_handle(handle.0 as *mut _) })
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum ProcessState {
    Alive,
    Exited,
}

fn process_state(owner: &Owner) -> Result<ProcessState, String> {
    use windows::Win32::Foundation::{WAIT_FAILED, WAIT_OBJECT_0, WAIT_TIMEOUT};
    use windows::Win32::System::Threading::WaitForSingleObject;
    let result = unsafe {
        WaitForSingleObject(
            windows::Win32::Foundation::HANDLE(owner.process.as_raw_handle()),
            0,
        )
    };
    match result {
        WAIT_OBJECT_0 => Ok(ProcessState::Exited),
        WAIT_TIMEOUT => Ok(ProcessState::Alive),
        WAIT_FAILED => Err(format!(
            "could not inspect stable process handle for pid={}: {}",
            owner.pid,
            std::io::Error::last_os_error()
        )),
        other => Err(format!(
            "unexpected Windows wait result {other:?} for pid={}",
            owner.pid
        )),
    }
}

fn looks_like_screenpipe_exe(path: &Path) -> bool {
    path.file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| {
            let name = name.to_ascii_lowercase();
            name == "screenpipe.exe" || name == "screenpipe-app.exe"
        })
}

fn same_path(left: &Path, right: &Path) -> bool {
    let left = std::fs::canonicalize(left).unwrap_or_else(|_| left.to_path_buf());
    let right = std::fs::canonicalize(right).unwrap_or_else(|_| right.to_path_buf());
    left.to_string_lossy()
        .eq_ignore_ascii_case(&right.to_string_lossy())
}

fn verify_current_session(pid: u32) -> Result<(), String> {
    let session = query_session(pid)?;
    if !session.is_current {
        return Err(format!(
            "refused to terminate pid={pid} in session {}; Enterprise is in session {}",
            session.owner, session.current
        ));
    }
    Ok(())
}

fn is_current_session(pid: u32) -> Result<bool, String> {
    Ok(query_session(pid)?.is_current)
}

struct SessionQuery {
    owner: u32,
    current: u32,
    is_current: bool,
}

fn query_session(pid: u32) -> Result<SessionQuery, String> {
    use windows::Win32::System::{
        RemoteDesktop::ProcessIdToSessionId, Threading::GetCurrentProcessId,
    };
    let mut owner_session = 0;
    let mut current_session = 0;
    unsafe {
        ProcessIdToSessionId(pid, &mut owner_session)
            .map_err(|error| format!("could not inspect owner session: {error}"))?;
        ProcessIdToSessionId(GetCurrentProcessId(), &mut current_session)
            .map_err(|error| format!("could not inspect Enterprise session: {error}"))?;
    }
    Ok(SessionQuery {
        owner: owner_session,
        current: current_session,
        is_current: owner_session == current_session,
    })
}

async fn listening_pid(port: u16) -> Result<Option<u32>, String> {
    use std::os::windows::process::CommandExt;
    let mut command = tokio::process::Command::new("netstat.exe");
    command.args(["-ano", "-p", "tcp"]);
    command.creation_flags(CREATE_NO_WINDOW);
    let output = command
        .output()
        .await
        .map_err(|error| format!("netstat failed: {error}"))?;
    if !output.status.success() {
        return Err(format!("netstat exited with {}", output.status));
    }
    let mut owners = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| listening_pid_from_line(line, port))
        .collect::<std::collections::HashSet<_>>();
    if owners.is_empty() {
        return Ok(None);
    }
    if owners.len() != 1 {
        return Err(format!(
            "expected one listener for control port {port}, found {}",
            owners.len()
        ));
    }
    let owner = owners.drain().next().expect("one owner checked");
    Ok(Some(owner))
}

fn listening_pid_from_line(line: &str, port: u16) -> Option<u32> {
    let fields: Vec<_> = line.split_whitespace().collect();
    if fields.len() < 5 || !fields[0].eq_ignore_ascii_case("TCP") {
        return None;
    }
    let local_port = fields[1].rsplit(':').next()?.parse::<u16>().ok()?;
    let remote_port = fields[2].rsplit(':').next()?.parse::<u16>().ok()?;
    (local_port == port && remote_port == 0).then(|| fields[4].parse().ok())?
}

async fn run_taskkill(pid: u32, force: bool) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    let mut command = tokio::process::Command::new("taskkill.exe");
    if force {
        command.arg("/F");
    }
    command.args(["/PID", &pid.to_string()]);
    command.creation_flags(CREATE_NO_WINDOW);
    let output = command
        .output()
        .await
        .map_err(|error| format!("taskkill could not start: {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "taskkill exited {}: {}",
            output.status,
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

async fn wait_for_owner_exit(owner: &Owner, port: u16, timeout: Duration) -> bool {
    let started = Instant::now();
    while started.elapsed() < timeout {
        let process_gone = match process_state(owner) {
            Ok(ProcessState::Exited) => true,
            Ok(ProcessState::Alive) => false,
            Err(cause) => {
                record(
                    "exit_wait_failed",
                    &format!("pid={} Windows cause: {cause}", owner.pid),
                    "enterprise_start_aborted",
                );
                return false;
            }
        };
        let port_free = tokio::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port))
            .await
            .is_ok();
        if process_gone && port_free {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(200)).await;
    }
    false
}

fn record(event: &str, cause: &str, outcome: &str) {
    let _guard = LOG_WRITER.lock().unwrap_or_else(|error| error.into_inner());
    if let Err(error) = append_record(event, cause, outcome) {
        eprintln!("screenpipe: could not persist Enterprise takeover diagnostic: {error}");
    }
}

fn append_record(event: &str, cause: &str, outcome: &str) -> std::io::Result<()> {
    let root = screenpipe_core::paths::default_screenpipe_data_dir();
    append_record_to(&root, event, cause, outcome)
}

fn append_record_to(root: &Path, event: &str, cause: &str, outcome: &str) -> std::io::Result<()> {
    std::fs::create_dir_all(&root)?;
    let path = root.join(LOG_NAME);
    if std::fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err(std::io::Error::other(
            "takeover diagnostic path is a symlink",
        ));
    }
    let mut file = std::fs::OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(path)?;
    if file.metadata()?.len() > MAX_LOG_BYTES {
        file.seek(SeekFrom::End(-(MAX_LOG_BYTES as i64 / 2)))?;
        let mut tail = Vec::new();
        file.read_to_end(&mut tail)?;
        let start = tail
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(tail.len(), |i| i + 1);
        file.set_len(0)?;
        file.rewind()?;
        file.write_all(&tail[start..])?;
    }
    file.seek(SeekFrom::End(0))?;
    writeln!(
        file,
        "{} event={} cause={} outcome={}",
        chrono::Utc::now().to_rfc3339(),
        event,
        cause
            .replace(['\r', '\n'], " ")
            .chars()
            .take(2048)
            .collect::<String>(),
        outcome
    )?;
    file.sync_data()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn enterprise_presence_fixture() {
        use windows::core::HSTRING;
        use windows::Win32::System::Threading::CreateMutexW;

        let Ok(name) = std::env::var("SCREENPIPE_ENTERPRISE_PRESENCE_FIXTURE") else {
            return;
        };
        let name = HSTRING::from(name);
        let handle = unsafe { CreateMutexW(None, false, &name) }.unwrap();
        // SAFETY: CreateMutexW returned an owned kernel handle, held until EOF.
        let _handle = unsafe { OwnedHandle::from_raw_handle(handle.0 as *mut _) };
        println!("presence-ready");
        let _ = std::io::read_to_string(std::io::stdin());
    }

    #[tokio::test]
    async fn consumer_blocks_until_live_enterprise_presence_exits() {
        use std::io::{BufRead, BufReader};
        use std::process::{Command, Stdio};

        let control_port = unused_port();
        let api_port = unused_port();
        let name = presence_name(control_port, api_port);
        let mut enterprise = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "windows_enterprise_takeover::tests::enterprise_presence_fixture",
                "--nocapture",
            ])
            .env("SCREENPIPE_ENTERPRISE_PRESENCE_FIXTURE", name)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut output = BufReader::new(enterprise.stdout.take().unwrap());
        let mut ready = String::new();
        while !ready.contains("presence-ready") {
            let mut line = String::new();
            assert_ne!(output.read_line(&mut line).unwrap(), 0);
            ready.push_str(&line);
        }

        assert!(enterprise_is_present(control_port, api_port).await.unwrap());
        drop(enterprise.stdin.take());
        assert!(enterprise.wait().unwrap().success());
        assert!(!enterprise_is_present(control_port, api_port).await.unwrap());
    }

    #[tokio::test]
    async fn consumer_allows_screenpipe_owner_without_product_metadata() {
        let control_port = unused_port();
        let api_port = unused_port();
        let temp = tempfile::tempdir().unwrap();
        let fixture_exe = temp.path().join("screenpipe.exe");
        std::fs::copy(std::env::current_exe().unwrap(), &fixture_exe).unwrap();
        remove_version_resource(&fixture_exe);
        assert_eq!(executable_product_name(&fixture_exe).unwrap(), None);

        let mut owner = spawn_owner_fixture(control_port, Some(&fixture_exe));
        wait_for_fixture(control_port).await;

        assert!(!enterprise_is_present(control_port, api_port).await.unwrap());
        assert!(owner.try_wait().unwrap().is_none());
        owner.kill().unwrap();
        let _ = owner.wait().unwrap();
    }

    #[test]
    fn shared_executable_uses_installed_package_identity() {
        let temp = tempfile::tempdir().unwrap();
        let executable = temp.path().join("screenpipe-app.exe");
        std::fs::copy(std::env::current_exe().unwrap(), &executable).unwrap();
        let config: serde_json::Value = serde_json::from_str(include_str!("../tauri.enterprise.conf.json")).unwrap();
        let identity = crate::package_identity::PackageIdentity {
            identifier: "screenpi.pe.enterprise".into(),
            product_name: "screenpipe enterprise".into(),
            version: env!("CARGO_PKG_VERSION").into(),
            updater: config["plugins"]["updater"].clone(),
            deep_link: config["plugins"]["deep-link"].clone(),
        };
        let metadata = temp.path().join(crate::package_identity::METADATA_FILE);
        std::fs::write(&metadata, serde_json::to_vec(&identity).unwrap()).unwrap();
        assert_eq!(executable_product_name(&executable).unwrap().as_deref(), Some(ENTERPRISE_PRODUCT_NAME));
        std::fs::write(&metadata, "{").unwrap();
        assert!(executable_product_name(&executable).unwrap_err().contains("parse"));
        std::fs::remove_file(metadata).unwrap();
        assert_ne!(executable_product_name(&executable).unwrap().as_deref(), Some(ENTERPRISE_PRODUCT_NAME));
    }

    fn remove_version_resource(path: &Path) {
        use std::ffi::c_void;

        #[link(name = "kernel32")]
        extern "system" {
            fn BeginUpdateResourceW(filename: *const u16, delete_existing: i32) -> *mut c_void;
            fn UpdateResourceW(
                update: *mut c_void,
                resource_type: *const u16,
                name: *const u16,
                language: u16,
                data: *const c_void,
                size: u32,
            ) -> i32;
            fn EndUpdateResourceW(update: *mut c_void, discard: i32) -> i32;
        }

        let path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
        let update = unsafe { BeginUpdateResourceW(path.as_ptr(), 0) };
        assert!(
            !update.is_null(),
            "BeginUpdateResourceW failed: {}",
            std::io::Error::last_os_error()
        );
        assert_ne!(
            unsafe {
                UpdateResourceW(
                    update,
                    16usize as *const u16,
                    1usize as *const u16,
                    0x0409,
                    std::ptr::null(),
                    0,
                )
            },
            0,
            "UpdateResourceW failed: {}",
            std::io::Error::last_os_error()
        );
        assert_ne!(
            unsafe { EndUpdateResourceW(update, 0) },
            0,
            "EndUpdateResourceW failed: {}",
            std::io::Error::last_os_error()
        );
    }

    #[test]
    fn screenpipe_owner_fixture() {
        let Ok(port) = std::env::var("SCREENPIPE_TAKEOVER_FIXTURE_PORT") else {
            return;
        };
        let listener = std::net::TcpListener::bind((
            std::net::Ipv4Addr::LOCALHOST,
            port.parse::<u16>().unwrap(),
        ))
        .unwrap();
        for stream in listener.incoming() {
            let mut stream = stream.unwrap();
            let mut request = [0_u8; 4096];
            let _ = stream.read(&mut request);
            stream
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\nok")
                .unwrap();
        }
    }

    #[tokio::test]
    async fn legacy_successful_focus_owner_is_replaced_after_confirmed_exit() {
        use std::process::{Command, Stdio};

        let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);

        let temp = tempfile::tempdir().unwrap();
        let fixture_exe = temp.path().join("screenpipe-app.exe");
        std::fs::copy(std::env::current_exe().unwrap(), &fixture_exe).unwrap();
        let mut child = Command::new(&fixture_exe)
            .args([
                "--exact",
                "windows_enterprise_takeover::tests::screenpipe_owner_fixture",
                "--nocapture",
            ])
            .env("SCREENPIPE_TAKEOVER_FIXTURE_PORT", port.to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();

        let client = reqwest::Client::new();
        let mut focused = false;
        for _ in 0..50 {
            if let Ok(response) = client
                .post(format!("http://127.0.0.1:{port}/focus"))
                .body("{}")
                .send()
                .await
            {
                assert!(response.status().is_success());
                focused = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        assert!(focused, "legacy focus fixture did not start");

        let outcome = take_over_screenpipe_owner(port).await.unwrap();
        assert_eq!(outcome, TakeoverOutcome::ReplacedCompetingOwner);
        let _terminated_status = child.wait().unwrap();
        assert!(std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, port)).is_ok());
    }

    fn spawn_owner_fixture(port: u16, copied_executable: Option<&Path>) -> std::process::Child {
        use std::process::{Command, Stdio};

        let executable = copied_executable
            .map(Path::to_path_buf)
            .unwrap_or_else(|| std::env::current_exe().unwrap());
        Command::new(executable)
            .args([
                "--exact",
                "windows_enterprise_takeover::tests::screenpipe_owner_fixture",
                "--nocapture",
            ])
            .env("SCREENPIPE_TAKEOVER_FIXTURE_PORT", port.to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap()
    }

    async fn wait_for_fixture(port: u16) {
        for _ in 0..50 {
            if std::net::TcpStream::connect((std::net::Ipv4Addr::LOCALHOST, port)).is_ok() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(100)).await;
        }
        panic!("owner fixture did not start on port {port}");
    }

    fn unused_port() -> u16 {
        let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).unwrap();
        listener.local_addr().unwrap().port()
    }

    #[tokio::test]
    async fn api_only_competing_owner_is_replaced() {
        let control_port = unused_port();
        let api_port = unused_port();
        let temp = tempfile::tempdir().unwrap();
        let fixture_exe = temp.path().join("screenpipe-app.exe");
        std::fs::copy(std::env::current_exe().unwrap(), &fixture_exe).unwrap();
        let mut api_owner = spawn_owner_fixture(api_port, Some(&fixture_exe));
        wait_for_fixture(api_port).await;

        assert_eq!(
            take_over_screenpipe_owners(control_port, api_port)
                .await
                .unwrap(),
            TakeoverOutcome::ReplacedCompetingOwner
        );
        let _ = api_owner.wait().unwrap();
    }

    #[tokio::test]
    async fn same_enterprise_control_still_clears_competing_api_owner() {
        let control_port = unused_port();
        let api_port = unused_port();
        let temp = tempfile::tempdir().unwrap();
        let fixture_exe = temp.path().join("screenpipe-app.exe");
        std::fs::copy(std::env::current_exe().unwrap(), &fixture_exe).unwrap();
        let mut control_owner = spawn_owner_fixture(control_port, None);
        let mut api_owner = spawn_owner_fixture(api_port, Some(&fixture_exe));
        wait_for_fixture(control_port).await;
        wait_for_fixture(api_port).await;

        assert_eq!(
            take_over_screenpipe_owners(control_port, api_port)
                .await
                .unwrap(),
            TakeoverOutcome::SameExecutable
        );
        assert!(control_owner.try_wait().unwrap().is_none());
        let _ = api_owner.wait().unwrap();
        control_owner.kill().unwrap();
        let _ = control_owner.wait().unwrap();
    }

    #[test]
    fn only_exact_screenpipe_executables_are_eligible() {
        assert!(looks_like_screenpipe_exe(Path::new(
            r"C:\Program Files\screenpipe\screenpipe-app.exe"
        )));
        assert!(looks_like_screenpipe_exe(Path::new(
            r"C:\Program Files\screenpipe\SCREENPIPE.EXE"
        )));
        assert!(!looks_like_screenpipe_exe(Path::new(
            r"C:\Temp\screenpipe-helper.exe"
        )));
        assert!(!looks_like_screenpipe_exe(Path::new(
            r"C:\Temp\not-screenpipe.exe"
        )));
    }

    #[test]
    fn listener_parser_is_exact_and_locale_independent() {
        assert_eq!(
            listening_pid_from_line("TCP 127.0.0.1:11435 0.0.0.0:0 LISTENING 42", 11435),
            Some(42)
        );
        assert_eq!(
            listening_pid_from_line("TCP [::1]:11435 [::]:0 NASLUCHIWANIE 43", 11435),
            Some(43)
        );
        assert_eq!(
            listening_pid_from_line("TCP 127.0.0.1:114350 0.0.0.0:0 LISTENING 42", 11435),
            None
        );
        assert_eq!(
            listening_pid_from_line("TCP 127.0.0.1:50100 127.0.0.1:11435 ESTABLISHED 42", 11435),
            None
        );
    }

    #[tokio::test]
    async fn failure_survives_restart_rotation_and_real_support_redaction() {
        let root = tempfile::tempdir().unwrap();
        append_record_to(
            root.path(),
            "termination_failed",
            "pid=42 Windows cause: Access is denied. (os error 5) contact=private@example.com",
            "enterprise_start_aborted",
        )
        .unwrap();
        std::fs::rename(
            root.path().join(LOG_NAME),
            root.path().join("enterprise-takeover.previous.log"),
        )
        .unwrap();
        append_record_to(
            root.path(),
            "startup_after_restart",
            "previous takeover failure retained",
            "support_collection_available",
        )
        .unwrap();
        append_record_to(
            root.path(),
            "consumer_blocked",
            "Enterprise presence verified for control_port=11435 api_port=3030",
            "consumer_start_aborted",
        )
        .unwrap();

        let report =
            crate::diagnostic_logs::collect_redacted_from_dirs(&[root.path().to_path_buf()])
                .await
                .unwrap();
        assert!(report.contains("termination_failed"));
        assert!(report.contains("Access is denied"));
        assert!(report.contains("os error 5"));
        assert!(report.contains("enterprise_start_aborted"));
        assert!(report.contains("startup_after_restart"));
        assert!(report.contains("consumer_blocked"));
        assert!(report.contains("consumer_start_aborted"));
        assert!(!report.contains("private@example.com"));
    }
}
