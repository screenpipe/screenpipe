// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

use std::future::Future;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tokio::sync::{Mutex, Notify};

/// Recheck authorization and intent after any in-flight recorder teardown.
pub(super) async fn attempt<F: Future<Output = Result<(), String>>>(
    lifecycle: &Mutex<()>,
    should_start: impl FnOnce() -> bool,
    start: impl FnOnce() -> F,
) -> Result<(), String> {
    let _lifecycle = lifecycle.lock().await;
    if should_start() {
        start().await?;
    }
    Ok(())
}

/// One native recovery owner, independent of the authenticating webview.
/// Every explicit intent change invalidates queued work, including a pause
/// followed by a new start while an older recovery is waiting.
#[derive(Default)]
pub(crate) struct Recovery {
    generation: AtomicU64,
    owner: Mutex<()>,
    changed: Notify,
}

impl Recovery {
    pub(crate) fn cancel(&self) {
        self.generation.fetch_add(1, Ordering::SeqCst);
        self.changed.notify_one();
    }

    pub(crate) fn generation(&self) -> u64 {
        self.generation.load(Ordering::SeqCst)
    }

    pub(crate) fn is_current(&self, generation: u64) -> bool {
        self.generation() == generation
    }

    /// Complete or exhaust this request without consuming a newer request.
    fn finish(&self, generation: u64) {
        let _ = self.generation.compare_exchange(
            generation,
            generation.wrapping_add(1),
            Ordering::SeqCst,
            Ordering::SeqCst,
        );
    }

    pub(super) async fn run<F: Future<Output = Result<(), String>>>(
        &self,
        generation: u64,
        should_start: impl Fn() -> bool,
        mut attempt: impl FnMut() -> F,
        retry_delays: &[Duration],
    ) -> Result<(), String> {
        let _owner = self.owner.lock().await;
        let mut attempts = 0;
        loop {
            if !self.is_current(generation) || !should_start() {
                self.finish(generation);
                return Ok(());
            }
            match attempt().await {
                Ok(()) => {
                    self.finish(generation);
                    return Ok(());
                }
                Err(error) => {
                    let Some(delay) = retry_delays.get(attempts) else {
                        self.finish(generation);
                        return Err(error);
                    };
                    attempts += 1;
                    tracing::warn!("enterprise: recording start failed; native retry {attempts} in {delay:?}: {error}");
                    // Do not hold the recorder lifecycle during backoff. A stop
                    // cancels this generation and wakes its owner immediately.
                    let sleep = tokio::time::sleep(*delay);
                    tokio::pin!(sleep);
                    loop {
                        if !self.is_current(generation) || !should_start() {
                            self.finish(generation);
                            return Ok(());
                        }
                        tokio::select! {
                            _ = &mut sleep => break,
                            _ = self.changed.notified() => {}
                        }
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, AtomicUsize};
    use std::sync::Arc;

    const SHORT_RETRY: [Duration; 2] = [Duration::from_millis(5), Duration::from_millis(10)];

    #[tokio::test]
    async fn dropped_webview_and_failed_first_start_recover_without_resubmission() {
        let recovery = Arc::new(Recovery::default());
        let lifecycle = Arc::new(Mutex::new(()));
        let teardown = lifecycle.lock().await;
        let attempts = Arc::new(AtomicUsize::new(0));
        let (reply, webview) = tokio::sync::oneshot::channel::<()>();
        drop(webview);
        let native = tokio::spawn({
            let recovery = recovery.clone();
            let lifecycle = lifecycle.clone();
            let attempts = attempts.clone();
            async move {
                let _ = reply.send(());
                recovery
                    .run(
                        0,
                        || true,
                        || async {
                            let _lifecycle = lifecycle.lock().await;
                            if attempts.fetch_add(1, Ordering::SeqCst) == 0 {
                                Err("transient initial startup failure".into())
                            } else {
                                Ok(())
                            }
                        },
                        &SHORT_RETRY,
                    )
                    .await
            }
        });
        tokio::task::yield_now().await;
        assert_eq!(attempts.load(Ordering::SeqCst), 0);
        drop(teardown);
        tokio::time::timeout(Duration::from_secs(1), native)
            .await
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn duplicate_requests_share_one_budget_and_one_successful_start() {
        let recovery = Recovery::default();
        let attempts = AtomicUsize::new(0);
        let run = || {
            recovery.run(
                0,
                || true,
                || async {
                    if attempts.fetch_add(1, Ordering::SeqCst) == 0 {
                        Err("settings not ready".into())
                    } else {
                        Ok(())
                    }
                },
                &SHORT_RETRY,
            )
        };
        let (a, b) = tokio::join!(run(), run());
        a.unwrap();
        b.unwrap();
        assert_eq!(attempts.load(Ordering::SeqCst), 2);
    }

    #[tokio::test]
    async fn repeated_failure_exhausts_one_paced_budget() {
        let recovery = Recovery::default();
        let attempts = AtomicUsize::new(0);
        let started = tokio::time::Instant::now();
        let result = recovery
            .run(
                0,
                || true,
                || async {
                    attempts.fetch_add(1, Ordering::SeqCst);
                    Err("unavailable".into())
                },
                &SHORT_RETRY,
            )
            .await;
        assert_eq!(result, Err("unavailable".into()));
        assert_eq!(attempts.load(Ordering::SeqCst), 3);
        assert!(started.elapsed() >= SHORT_RETRY.iter().sum::<Duration>());
        recovery
            .run(
                0,
                || true,
                || async { panic!("exhausted request restarted") },
                &SHORT_RETRY,
            )
            .await
            .unwrap();
    }

    #[tokio::test]
    async fn pause_cancels_backoff_without_waiting_for_delay_or_holding_lifecycle() {
        let recovery = Recovery::default();
        let lifecycle = Mutex::new(());
        let failed = Notify::new();
        let intent = AtomicBool::new(true);
        let attempts = AtomicUsize::new(0);
        let long_retry = [Duration::from_secs(60)];
        let run = recovery.run(
            0,
            || intent.load(Ordering::SeqCst),
            || async {
                let _lifecycle = lifecycle.lock().await;
                attempts.fetch_add(1, Ordering::SeqCst);
                failed.notify_one();
                Err("temporary".into())
            },
            &long_retry,
        );
        let pause = async {
            failed.notified().await;
            let _lifecycle = lifecycle.lock().await;
            intent.store(false, Ordering::SeqCst);
            recovery.cancel();
        };
        tokio::time::timeout(Duration::from_secs(1), async {
            let (result, ()) = tokio::join!(run, pause);
            result.unwrap();
        })
        .await
        .unwrap();
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
        assert!(!intent.load(Ordering::SeqCst));
    }

    #[tokio::test]
    async fn revocation_quit_and_manual_recovery_cancel_retry() {
        for reason in ["revocation", "quit", "manual recovery"] {
            let recovery = Recovery::default();
            let permitted = AtomicBool::new(true);
            let attempts = AtomicUsize::new(0);
            recovery
                .run(
                    0,
                    || permitted.load(Ordering::SeqCst),
                    || async {
                        attempts.fetch_add(1, Ordering::SeqCst);
                        permitted.store(false, Ordering::SeqCst);
                        Err(reason.into())
                    },
                    &SHORT_RETRY,
                )
                .await
                .unwrap();
            assert_eq!(attempts.load(Ordering::SeqCst), 1);
        }
    }

    #[tokio::test]
    async fn new_intent_invalidates_old_work_even_if_recording_is_requested_again() {
        let recovery = Recovery::default();
        let old_generation = recovery.generation();
        recovery.cancel(); // pause
        recovery.cancel(); // subsequent explicit start
        recovery
            .run(
                old_generation,
                || true,
                || async { panic!("stale start") },
                &SHORT_RETRY,
            )
            .await
            .unwrap();
        assert!(recovery.is_current(2));
        recovery
            .run(2, || true, || async { Ok(()) }, &SHORT_RETRY)
            .await
            .unwrap();
        assert!(!recovery.is_current(2));
    }

    #[tokio::test]
    async fn cancellation_while_waiting_for_teardown_never_starts_capture() {
        let recovery = Recovery::default();
        let lifecycle = Mutex::new(());
        let teardown = lifecycle.lock().await;
        let allowed = || recovery.is_current(0);
        let native = recovery.run(
            0,
            allowed,
            || attempt(&lifecycle, allowed, || async { panic!("stale start") }),
            &SHORT_RETRY,
        );
        let pause = async {
            tokio::task::yield_now().await;
            recovery.cancel();
            drop(teardown);
        };
        let (result, ()) = tokio::join!(native, pause);
        result.unwrap();
    }
}
