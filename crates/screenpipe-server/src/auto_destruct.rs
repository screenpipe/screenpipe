#[cfg(target_os = "windows")]
use std::process::Command;
use std::time::Duration;
use tokio::time::sleep;
#[cfg(target_os = "windows")]
use tracing::debug;
use tracing::info;
#[cfg(target_os = "windows")]
use windows::Win32::Foundation::{CloseHandle, HANDLE, STILL_ACTIVE};
#[cfg(target_os = "windows")]
use windows::Win32::System::Threading::{
    GetExitCodeProcess, OpenProcess, PROCESS_QUERY_INFORMATION,
};

#[cfg(target_os = "windows")]
fn is_process_alive(pid: u32) -> bool {
    unsafe {
        let process: HANDLE = match OpenProcess(PROCESS_QUERY_INFORMATION, false, pid) {
            Ok(handle) => handle,
            Err(e) => {
                debug!("Failed to open process with PID ({}): {:?}", pid, e);
                return false;
            }
        };
        if process.is_invalid() {
            return false;
        }
        let mut exit_code: u32 = 0;
        let result = GetExitCodeProcess(process, &mut exit_code);
        CloseHandle(process).expect("Failed to close process handle");
        if result.is_err() {
            debug!("Failed to get exit code for process with PID ({})", pid);
            return false;
        }
        exit_code == STILL_ACTIVE.0 as u32
    }
}

pub async fn watch_pid(pid: u32) -> bool {
    info!("starting to watch for app termination (pid: {})", pid);

    loop {
        #[cfg(target_os = "windows")]
        {
            // Try Windows API first
            if !is_process_alive(pid) {
                debug!("Process ({}) not found via windows api", pid);
                return true;
            }

            // Fallback to Command approach
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x08000000;

            let pid_output = Command::new("tasklist")
                .args(&["/FI", &format!("PID eq {}", pid), "/NH", "/FO", "CSV"])
                .creation_flags(CREATE_NO_WINDOW)
                .output()
                .expect("failed to check pid");

            let mut app_cmd = Command::new("tasklist");
            app_cmd.args(&[
                "/FI",
                "IMAGENAME eq screenpipe-app.exe",
                "/NH",
                "/FO",
                "CSV",
            ]);
            app_cmd.creation_flags(CREATE_NO_WINDOW);
            let app_output = app_cmd.output().expect("failed to check app name");

            let pid_alive = String::from_utf8_lossy(&pid_output.stdout).contains(&pid.to_string());
            let app_alive = !String::from_utf8_lossy(&app_output.stdout).is_empty();

            if !pid_alive || !app_alive {
                return true;
            }
        }

        #[cfg(not(target_os = "windows"))]
        {
            // Use kill(pid, 0) — a zero-cost syscall that checks if process exists
            // without spawning a child process every second.
            let alive = unsafe { libc::kill(pid as i32, 0) };
            if alive != 0 {
                return true;
            }
        }

        sleep(Duration::from_secs(5)).await;
    }
}
