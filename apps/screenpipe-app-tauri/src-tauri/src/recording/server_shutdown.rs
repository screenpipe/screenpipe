// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

use std::future::Future;
use std::path::Path;
use tokio::sync::Mutex;

/// A caller's timeout must not drop an engine whose SQLite owners are still
/// draining. Keep the task in app state and join it before admitting a new core.
#[derive(Default)]
pub(crate) struct ServerShutdown {
    pending: Mutex<Option<tauri::async_runtime::JoinHandle<()>>>,
}

impl ServerShutdown {
    pub(super) async fn finish<T, F, Fut>(
        &self,
        server: Option<T>,
        data_dir: &Path,
        shutdown: F,
    ) -> Result<(), String>
    where
        T: Send + 'static,
        F: FnOnce(T) -> Fut,
        Fut: Future<Output = ()> + Send + 'static,
    {
        let mut pending = self.pending.lock().await;
        if let Some(server) = server {
            assert!(
                pending.is_none(),
                "server generations must not overlap shutdown"
            );
            // The dedicated engine runtime stays alive via ServerCore's sender.
            // This task must belong to the process runtime, which outlives it.
            let work = shutdown(server);
            let root = data_dir.to_path_buf();
            super::recovery_log::append(
                &root,
                "shutdown_started",
                "draining old engine before reopening database",
            );
            *pending = Some(tauri::async_runtime::spawn(async move {
                work.await;
                super::recovery_log::append(
                    &root,
                    "shutdown_completed",
                    "old database owners released",
                );
            }));
        }
        if let Some(task) = pending.as_mut() {
            let mut waiting = ShutdownWait {
                data_dir,
                completed: false,
            };
            let result = task.await;
            waiting.completed = true;
            *pending = None;
            result.map_err(|error| {
                let error = format!("server shutdown task failed: {error}");
                super::recovery_log::append(data_dir, "shutdown_failed", &error);
                error
            })?;
        }
        Ok(())
    }
}

struct ShutdownWait<'a> {
    data_dir: &'a Path,
    completed: bool,
}

impl Drop for ShutdownWait<'_> {
    fn drop(&mut self) {
        if !self.completed {
            super::recovery_log::append(
                self.data_dir,
                "shutdown_wait_cancelled",
                "caller timed out or cancelled; cleanup continues and database reopen must wait",
            );
        }
    }
}
