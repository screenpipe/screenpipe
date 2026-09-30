// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Quit-to-search uses the current process, API, and database owner.

use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager};
use tracing::{info, warn};

static CAPTURE_PAUSED: AtomicBool = AtomicBool::new(false);
static ENTERING: AtomicBool = AtomicBool::new(false);
static SESSION_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
const SESSION_FILE: &str = "search-session.json";

#[derive(Default, Serialize, Deserialize)]
#[serde(default)]
struct Session {
    capture_paused: bool,
    resume_search_only: bool,
}

pub fn is_active() -> bool {
    screenpipe_core::background_work::is_suspended()
}

pub fn capture_paused() -> bool {
    CAPTURE_PAUSED.load(Ordering::SeqCst)
}

pub fn is_entering() -> bool {
    ENTERING.load(Ordering::SeqCst)
}

fn persist_at(root: &Path, session: &Session) -> Result<(), String> {
    std::fs::create_dir_all(root).map_err(|e| e.to_string())?;
    let mut file = tempfile::NamedTempFile::new_in(root).map_err(|e| e.to_string())?;
    serde_json::to_writer(&mut file, session).map_err(|e| e.to_string())?;
    file.flush().map_err(|e| e.to_string())?;
    file.as_file().sync_all().map_err(|e| e.to_string())?;
    file.persist(root.join(SESSION_FILE))
        .map_err(|e| e.to_string())?;
    #[cfg(unix)]
    std::fs::File::open(root)
        .and_then(|dir| dir.sync_all())
        .map_err(|e| e.to_string())?;
    Ok(())
}

fn load_at(root: &Path) -> Result<Session, String> {
    match std::fs::read(root.join(SESSION_FILE)) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| e.to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Session::default()),
        Err(e) => Err(e.to_string()),
    }
}

fn persist(resume_search_only: bool) -> Result<(), String> {
    let _guard = SESSION_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    persist_at(
        &crate::config::app_data_dir(),
        &Session {
            capture_paused: capture_paused(),
            resume_search_only,
        },
    )
}

fn diagnostic(event: &str, detail: &str) {
    crate::recording::recovery_log::append(&crate::config::app_data_dir(), event, detail);
}

/// Restore stopped capture before any native startup or UI callback can run.
/// Only an updater/relaunch handoff restores hidden UI; a later manual launch
/// after a normal process exit opens the UI with recording still stopped.
pub fn initialize() -> bool {
    let session = load_at(&crate::config::app_data_dir()).unwrap_or_else(|error| {
        diagnostic(
            "search_session_read_failed",
            &format!("cause={error}; outcome=capture_paused"),
        );
        Session {
            capture_paused: true,
            resume_search_only: false,
        }
    });
    CAPTURE_PAUSED.store(session.capture_paused, Ordering::SeqCst);
    let background = session.capture_paused && session.resume_search_only;
    screenpipe_core::background_work::set_suspended(background);
    if let Err(error) = persist(false) {
        diagnostic(
            "search_session_restore_failed",
            &format!("cause={error}; outcome=capture_paused"),
        );
        CAPTURE_PAUSED.store(true, Ordering::SeqCst);
    }
    background
}

pub fn keep_after_quit(app: &AppHandle) -> bool {
    crate::store::SettingsStore::get(app)
        .ok()
        .flatten()
        .map(|s| s.keep_search_available_after_quit)
        .unwrap_or(true)
}

/// Called only by explicit recording controls, before publishing capture intent.
pub fn resume_capture() -> Result<(), String> {
    let _guard = SESSION_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if ENTERING.load(Ordering::SeqCst) || is_active() {
        return Err("Open Screenpipe before resuming recording.".into());
    }
    persist_at(&crate::config::app_data_dir(), &Session::default())?;
    CAPTURE_PAUSED.store(false, Ordering::SeqCst);
    Ok(())
}

/// Opening a window restores ordinary background work, never capture intent.
pub fn wake() -> bool {
    if ENTERING.load(Ordering::SeqCst) || !is_active() {
        return false;
    }
    screenpipe_core::background_work::set_suspended(false);
    info!("search-only: UI reopened; recording remains paused");
    true
}

pub fn prepare_restart() -> Result<(), String> {
    persist(is_active()).map_err(|error| {
        diagnostic(
            "search_restart_persist_failed",
            &format!("cause={error}; outcome=restart_deferred"),
        );
        error
    })
}

pub fn cancel_restart() {
    if let Err(error) = persist(false) {
        diagnostic("search_restart_cancel_failed", &error);
    }
}

/// A deferred installer may already have drained the API. The ordinary start
/// path joins pending shutdown before opening a database; the paused intent
/// above prevents this recovery from starting capture.
pub fn recover_after_failed_update(app: AppHandle) {
    if !is_active() {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let result = crate::recording::spawn_screenpipe(
            app.state::<crate::recording::RecordingState>(),
            app.clone(),
            None,
        )
        .await;
        match result {
            Ok(()) => diagnostic(
                "search_update_recovered",
                "outcome=search_restored; capture=paused",
            ),
            Err(error) => diagnostic(
                "search_update_recovery_failed",
                &format!("cause={error}; outcome=search_unavailable; capture=paused"),
            ),
        }
    });
}

pub fn request_enter(app: AppHandle) {
    let guard = SESSION_LOCK.lock().unwrap_or_else(|e| e.into_inner());
    if ENTERING.swap(true, Ordering::SeqCst) {
        return;
    }
    CAPTURE_PAUSED.store(true, Ordering::SeqCst);
    screenpipe_core::background_work::set_suspended(true);
    if let Some(state) = app.try_state::<crate::recording::RecordingState>() {
        state.set_capture_intent(false);
    }
    drop(guard);

    // Own the stop future in a task: a deadline must not drop capture midway
    // through shutdown. On failure, the existing full-exit path owns cleanup.
    tauri::async_runtime::spawn(async move {
        let app_for_stop = app.clone();
        let mut stop = tauri::async_runtime::spawn(async move {
            let saved = persist(false);
            // Requests admitted before Quit may still be starting a device.
            // Finish those before stopping capture; later mutations are denied.
            screenpipe_engine::search_only::finish_in_flight_mutations().await;
            crate::recording::stop_capture(
                app_for_stop.state::<crate::recording::RecordingState>(),
                app_for_stop.clone(),
            )
            .await?;
            saved?;
            let pipes = app_for_stop
                .state::<crate::recording::RecordingState>()
                .server
                .lock()
                .await
                .as_ref()
                .map(|server| server.pipe_manager.clone());
            if let Some(pipes) = pipes {
                let pipes = pipes.lock().await;
                for pipe in pipes
                    .list_pipes()
                    .await
                    .into_iter()
                    .filter(|pipe| pipe.is_running)
                {
                    pipes
                        .stop_pipe(&pipe.config.name)
                        .await
                        .map_err(|e| e.to_string())?;
                }
                tokio::time::timeout(Duration::from_secs(10), async {
                    while pipes.list_pipes().await.iter().any(|pipe| pipe.is_running) {
                        tokio::time::sleep(Duration::from_millis(100)).await;
                    }
                })
                .await
                .map_err(|_| "workflow_stop_timeout".to_string())?;
            } else {
                return Err("The local history server is unavailable.".into());
            }
            if let Some(pi) = app_for_stop.try_state::<crate::pi::PiState>() {
                crate::pi::cleanup_pi(&pi).await;
            }
            crate::headless::enter(app_for_stop).await?;
            Ok::<(), String>(())
        });
        let result = match tokio::time::timeout(Duration::from_secs(30), &mut stop).await {
            Ok(result) => result,
            Err(_) => {
                diagnostic(
                    "search_only_stop_slow",
                    "cause=quit_transition_timeout; outcome=full_exit",
                );
                crate::process_exit::request_full_app_quit(app);
                return;
            }
        };
        match result {
            Ok(Ok(())) => {
                diagnostic(
                    "search_only_ready",
                    "outcome=capture_stopped; api=retained; ui=closed",
                );
                #[cfg(target_os = "macos")]
                if crate::staged_update::staged_version().is_some() {
                    if let Err(error) = crate::updates::restart_for_update(app.clone(), None).await
                    {
                        diagnostic(
                            "search_only_update_failed",
                            &format!("cause={error}; outcome=update_deferred"),
                        );
                    }
                }
            }
            failure => {
                let error = format!("{failure:?}");
                warn!("search-only transition failed: {error}");
                diagnostic(
                    "search_only_failed",
                    &format!("cause={error}; outcome=full_exit"),
                );
                // Quit must stop capture even if retaining search fails.
                crate::process_exit::request_full_app_quit(app);
                return;
            }
        }
        ENTERING.store(false, Ordering::SeqCst);
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restart_snapshot_keeps_capture_off_and_is_consumed_without_clearing_pause() {
        let dir = tempfile::tempdir().unwrap();
        assert!(!load_at(dir.path()).unwrap().capture_paused);
        persist_at(
            dir.path(),
            &Session {
                capture_paused: true,
                resume_search_only: true,
            },
        )
        .unwrap();
        let restored = load_at(dir.path()).unwrap();
        assert!(restored.capture_paused && restored.resume_search_only);
        persist_at(
            dir.path(),
            &Session {
                resume_search_only: false,
                ..restored
            },
        )
        .unwrap();
        let manual = load_at(dir.path()).unwrap();
        assert!(manual.capture_paused);
        assert!(!manual.resume_search_only);
        persist_at(dir.path(), &Session::default()).unwrap();
        assert!(!load_at(dir.path()).unwrap().capture_paused);
    }

    #[test]
    fn damaged_session_is_an_error_not_permission_to_record() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join(SESSION_FILE), b"{interrupted").unwrap();
        assert!(load_at(dir.path()).is_err());
    }

    #[tokio::test]
    async fn quit_failure_reaches_collected_redacted_support_report_after_restart() {
        let dir = tempfile::tempdir().unwrap();
        // Exercise a real persistence failure, not an invented log message.
        std::fs::create_dir(dir.path().join(SESSION_FILE)).unwrap();
        let cause = persist_at(
            dir.path(),
            &Session {
                capture_paused: true,
                resume_search_only: true,
            },
        )
        .unwrap_err();
        crate::recording::recovery_log::append(
            dir.path(),
            "search_restart_persist_failed",
            &format!("cause={cause}; outcome=restart_deferred; contact=private-person@example.com"),
        );
        // Ordinary app log rotation/restart must not discard the lifecycle cause.
        for day in 1..=7 {
            std::fs::write(
                dir.path()
                    .join(format!("screenpipe-app.2026-09-{day:02}.log")),
                "app restarted\n",
            )
            .unwrap();
        }
        assert!(load_at(dir.path()).is_err());
        let report =
            crate::diagnostic_logs::collect_redacted_from_dirs(&[dir.path().to_path_buf()])
                .await
                .unwrap();
        assert!(report.contains("search_restart_persist_failed"));
        assert!(report.contains("restart_deferred"));
        assert!(report.contains(&cause));
        assert!(!report.contains("private-person@example.com"));
    }
}
