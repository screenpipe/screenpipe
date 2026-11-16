// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

use std::time::Duration;

/// Healthy diagnostics are summaries, not activity events. Local sampling and
/// failure checks keep their existing cadence.
pub const DESKTOP_DIAGNOSTIC_REPORT_INTERVAL: Duration = Duration::from_secs(5 * 60);
pub const CLI_DIAGNOSTIC_REPORT_INTERVAL: Duration = Duration::from_secs(15 * 60);

/// Routine CPU/RAM fleet summaries are hourly. Keep local resource sampling
/// and recording-pipeline health reporting independent of this upload cadence.
pub const RESOURCE_DIAGNOSTIC_REPORT_INTERVAL: Duration = Duration::from_secs(60 * 60);

const FINAL_REPORT_TIMEOUT: Duration = Duration::from_millis(750);

/// Shared by resource and pipeline reporters in one engine generation. Flushes
/// run concurrently and cannot hold up graceful quit on a slow network.
#[derive(Default)]
pub struct DiagnosticShutdown {
    stop: tokio_util::sync::CancellationToken,
    tasks: tokio_util::task::TaskTracker,
}

impl DiagnosticShutdown {
    pub(crate) fn track(
        &self,
        future: impl std::future::Future<Output = ()> + Send + 'static,
    ) -> impl std::future::Future<Output = ()> + Send + 'static {
        self.tasks.track_future(future)
    }

    pub(crate) async fn cancelled(&self) {
        self.stop.cancelled().await;
    }

    /// Best effort: a network failure must not prevent quitting or restarting.
    pub async fn flush(&self) {
        self.stop.cancel();
        self.tasks.close();
        if tokio::time::timeout(Duration::from_secs(1), self.tasks.wait())
            .await
            .is_err()
        {
            tracing::debug!("diagnostic shutdown flush timed out");
        }
    }
}

pub(crate) async fn finish_report(report: impl std::future::Future<Output = ()>) {
    if tokio::time::timeout(FINAL_REPORT_TIMEOUT, report)
        .await
        .is_err()
    {
        tracing::debug!("final diagnostic report timed out");
    }
}

/// Report startup, changed failure/device state, and a periodic heartbeat.
/// State contains only failure counters and device identity, never work counters:
/// increasing frames/chunks must not turn every healthy sample into a report.
pub(crate) struct HealthReportSchedule<T> {
    interval: Duration,
    last_report: Option<(Duration, T)>,
}

impl<T: PartialEq> HealthReportSchedule<T> {
    pub(crate) fn new(interval: Duration) -> Self {
        Self {
            interval,
            last_report: None,
        }
    }

    pub(crate) fn should_report(&mut self, elapsed: Duration, state: T) -> bool {
        let report = self.last_report.as_ref().is_none_or(|(last, previous)| {
            elapsed.saturating_sub(*last) >= self.interval || *previous != state
        });
        if report {
            self.last_report = Some((elapsed, state));
        }
        report
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn desktop_healthy_minute_checks_emit_twelve_snapshots_per_hour() {
        let mut schedule = HealthReportSchedule::new(DESKTOP_DIAGNOSTIC_REPORT_INTERVAL);
        let reports: Vec<_> = (0..60)
            .filter(|minute| schedule.should_report(Duration::from_secs(minute * 60), [0, 0]))
            .collect();
        assert_eq!(reports, (0..60).step_by(5).collect::<Vec<_>>());
    }

    #[test]
    fn new_failures_report_on_the_next_check_without_waiting_for_heartbeat() {
        let mut schedule = HealthReportSchedule::new(DESKTOP_DIAGNOSTIC_REPORT_INTERVAL);
        assert!(schedule.should_report(Duration::ZERO, [0, 0]));
        assert!(schedule.should_report(Duration::from_secs(60), [1, 0]));
        assert!(!schedule.should_report(Duration::from_secs(120), [1, 0]));
        assert!(schedule.should_report(Duration::from_secs(180), [1, 1]));
    }

    #[test]
    fn repeated_failures_are_not_sampled_away() {
        let mut schedule = HealthReportSchedule::new(DESKTOP_DIAGNOSTIC_REPORT_INTERVAL);
        for minute in 0..60 {
            assert!(schedule.should_report(Duration::from_secs(minute * 60), [minute]));
        }
    }

    #[test]
    fn device_replacement_with_same_count_is_reported() {
        let mut schedule = HealthReportSchedule::new(DESKTOP_DIAGNOSTIC_REPORT_INTERVAL);
        assert!(schedule.should_report(Duration::ZERO, ([0], vec!["mic-a"])));
        assert!(schedule.should_report(Duration::from_secs(60), ([0], vec!["mic-b"])));
        assert!(!schedule.should_report(Duration::from_secs(120), ([0], vec!["mic-b"])));
    }

    #[test]
    fn counter_reset_and_fresh_reporter_are_reported() {
        let mut schedule = HealthReportSchedule::new(DESKTOP_DIAGNOSTIC_REPORT_INTERVAL);
        assert!(schedule.should_report(Duration::from_secs(300), [10]));
        assert!(schedule.should_report(Duration::from_secs(360), [0]));
        let mut restarted = HealthReportSchedule::new(DESKTOP_DIAGNOSTIC_REPORT_INTERVAL);
        assert!(restarted.should_report(Duration::ZERO, [0]));
    }

    #[test]
    fn exact_boundary_and_long_sleep_report_once() {
        let mut schedule = HealthReportSchedule::new(DESKTOP_DIAGNOSTIC_REPORT_INTERVAL);
        assert!(schedule.should_report(Duration::ZERO, [0]));
        assert!(!schedule.should_report(
            DESKTOP_DIAGNOSTIC_REPORT_INTERVAL - Duration::from_secs(1),
            [0]
        ));
        assert!(schedule.should_report(DESKTOP_DIAGNOSTIC_REPORT_INTERVAL, [0]));
        let after_sleep = Duration::from_secs(24 * 3600);
        assert!(schedule.should_report(after_sleep, [0]));
        assert!(!schedule.should_report(after_sleep, [0]));
    }

    #[test]
    fn cli_healthy_minute_checks_emit_four_snapshots_per_hour() {
        let mut schedule = HealthReportSchedule::new(CLI_DIAGNOSTIC_REPORT_INTERVAL);
        let reports: Vec<_> = (0..60)
            .filter(|minute| schedule.should_report(Duration::from_secs(minute * 60), [0]))
            .collect();
        assert_eq!(reports, [0, 15, 30, 45]);
    }

    #[tokio::test(start_paused = true)]
    async fn shutdown_flushes_latest_partial_window_without_waiting_for_timer() {
        use std::sync::{
            atomic::{AtomicU64, Ordering},
            Arc,
        };
        let shutdown = Arc::new(DiagnosticShutdown::default());
        let latest = Arc::new(AtomicU64::new(0));
        let (tx, rx) = tokio::sync::oneshot::channel();
        let signal = shutdown.clone();
        let snapshot = latest.clone();
        let task = tokio::spawn(shutdown.track(async move {
            signal.cancelled().await;
            finish_report(async move {
                let _ = tx.send(snapshot.load(Ordering::Relaxed));
            })
            .await;
        }));
        latest.store(123, Ordering::Relaxed);
        // No five-minute tick has elapsed. The final snapshot is fresh.
        shutdown.flush().await;
        assert_eq!(rx.await.unwrap(), 123);
        task.await.unwrap();
        // Repeated shutdown must not emit another report or hang.
        shutdown.flush().await;
    }

    #[tokio::test(start_paused = true)]
    async fn slow_final_upload_is_cancelled_without_holding_up_quit() {
        use std::sync::Arc;
        let shutdown = Arc::new(DiagnosticShutdown::default());
        let signal = shutdown.clone();
        let task = tokio::spawn(shutdown.track(async move {
            signal.cancelled().await;
            finish_report(std::future::pending()).await;
        }));
        let start = tokio::time::Instant::now();
        shutdown.flush().await;
        assert!(start.elapsed() <= Duration::from_secs(1));
        task.await.unwrap();
    }

    #[tokio::test]
    async fn aborted_router_reporter_does_not_leave_flush_waiting_for_a_dead_task() {
        let shutdown = DiagnosticShutdown::default();
        let task = tokio::spawn(shutdown.track(std::future::pending()));
        task.abort();
        let _ = task.await;
        shutdown.flush().await;
    }
}
