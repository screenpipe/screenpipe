// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

use std::time::Duration;

/// Healthy diagnostics are summaries, not activity events. Local sampling and
/// failure checks keep their existing cadence.
pub const DIAGNOSTIC_REPORT_INTERVAL: Duration = Duration::from_secs(15 * 60);

/// Report startup, changed failure/device state, and a periodic heartbeat.
/// State contains only failure counters and device identity, never work counters:
/// increasing frames/chunks must not turn every healthy sample into a report.
pub(crate) struct HealthReportSchedule<T> {
    last_report: Option<(Duration, T)>,
}

impl<T: PartialEq> HealthReportSchedule<T> {
    pub(crate) fn new() -> Self {
        Self { last_report: None }
    }

    pub(crate) fn should_report(&mut self, elapsed: Duration, state: T) -> bool {
        let report = self.last_report.as_ref().is_none_or(|(last, previous)| {
            elapsed.saturating_sub(*last) >= DIAGNOSTIC_REPORT_INTERVAL || *previous != state
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
    fn healthy_minute_checks_emit_four_snapshots_per_hour() {
        let mut schedule = HealthReportSchedule::new();
        let reports: Vec<_> = (0..60)
            .filter(|minute| schedule.should_report(Duration::from_secs(minute * 60), [0, 0]))
            .collect();
        assert_eq!(reports, [0, 15, 30, 45]);
    }

    #[test]
    fn new_failures_report_on_the_next_check_without_waiting_for_heartbeat() {
        let mut schedule = HealthReportSchedule::new();
        assert!(schedule.should_report(Duration::ZERO, [0, 0]));
        assert!(schedule.should_report(Duration::from_secs(60), [1, 0]));
        assert!(!schedule.should_report(Duration::from_secs(120), [1, 0]));
        assert!(schedule.should_report(Duration::from_secs(180), [1, 1]));
    }

    #[test]
    fn repeated_failures_are_not_sampled_away() {
        let mut schedule = HealthReportSchedule::new();
        for minute in 0..60 {
            assert!(schedule.should_report(Duration::from_secs(minute * 60), [minute]));
        }
    }

    #[test]
    fn device_replacement_with_same_count_is_reported() {
        let mut schedule = HealthReportSchedule::new();
        assert!(schedule.should_report(Duration::ZERO, ([0], vec!["mic-a"])));
        assert!(schedule.should_report(Duration::from_secs(60), ([0], vec!["mic-b"])));
        assert!(!schedule.should_report(Duration::from_secs(120), ([0], vec!["mic-b"])));
    }

    #[test]
    fn counter_reset_and_fresh_reporter_are_reported() {
        let mut schedule = HealthReportSchedule::new();
        assert!(schedule.should_report(Duration::from_secs(300), [10]));
        assert!(schedule.should_report(Duration::from_secs(360), [0]));
        let mut restarted = HealthReportSchedule::new();
        assert!(restarted.should_report(Duration::ZERO, [0]));
    }

    #[test]
    fn exact_boundary_and_long_sleep_report_once() {
        let mut schedule = HealthReportSchedule::new();
        assert!(schedule.should_report(Duration::ZERO, [0]));
        assert!(!schedule.should_report(DIAGNOSTIC_REPORT_INTERVAL - Duration::from_secs(1), [0]));
        assert!(schedule.should_report(DIAGNOSTIC_REPORT_INTERVAL, [0]));
        let after_sleep = Duration::from_secs(24 * 3600);
        assert!(schedule.should_report(after_sleep, [0]));
        assert!(!schedule.should_report(after_sleep, [0]));
    }
}
