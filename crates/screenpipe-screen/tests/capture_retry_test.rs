/// Rigorous tests for the capture retry + refresh logic in continuous_capture.
///
/// The retry pattern (from core.rs):
/// - Up to MAX_CAPTURE_RETRIES (3) attempts per capture cycle
/// - On failure, calls monitor.refresh() then retries after 100ms
/// - On all retries exhausted: increments consecutive_capture_failures
/// - After MAX_CONSECUTIVE_FAILURES (30) consecutive all-retry-exhausted cycles, returns Err
/// - On any success: resets consecutive_capture_failures to 0
///
/// We replicate the exact control flow here with a mock capture function
/// to verify every branch.
use std::sync::atomic::{AtomicU32, Ordering};
use std::sync::Arc;

const MAX_CAPTURE_RETRIES: u32 = 3;
const MAX_CONSECUTIVE_FAILURES: u32 = 30;

/// Outcome of a single capture cycle (one iteration of the outer loop)
#[derive(Debug, PartialEq)]
enum CycleOutcome {
    /// Capture succeeded (possibly after retries)
    Success { attempts_used: u32 },
    /// All retries exhausted, but haven't hit consecutive failure limit yet
    RetryExhausted { consecutive_failures: u32 },
    /// Hit the consecutive failure limit — bail
    Bail { consecutive_failures: u32 },
}

/// Replicate the exact retry logic from continuous_capture.
/// `capture_fn` returns Ok(()) on success, Err on failure.
/// `refresh_fn` is called between retries.
/// Returns the outcome of a single capture cycle.
fn run_capture_cycle<F: ?Sized, R: ?Sized>(
    capture_fn: &mut F,
    refresh_fn: &mut R,
    consecutive_failures: &mut u32,
) -> CycleOutcome
where
    F: FnMut() -> Result<(), String>,
    R: FnMut() -> Result<(), String>,
{
    let mut captured = false;
    let mut attempts_used = 0;

    // Exact replica of the for loop in core.rs
    for attempt in 0..=MAX_CAPTURE_RETRIES {
        match capture_fn() {
            Ok(()) => {
                *consecutive_failures = 0;
                captured = true;
                attempts_used = attempt + 1;
                break;
            }
            Err(_e) => {
                if attempt < MAX_CAPTURE_RETRIES {
                    // refresh() between retries
                    let _ = refresh_fn();
                }
            }
        }
    }

    if captured {
        CycleOutcome::Success { attempts_used }
    } else {
        *consecutive_failures += 1;
        if *consecutive_failures >= MAX_CONSECUTIVE_FAILURES {
            CycleOutcome::Bail {
                consecutive_failures: *consecutive_failures,
            }
        } else {
            CycleOutcome::RetryExhausted {
                consecutive_failures: *consecutive_failures,
            }
        }
    }
}

// =============================================================================
// Tests for the retry logic
// =============================================================================

#[test]
fn test_immediate_success_resets_consecutive_failures() {
    let mut consecutive = 5; // simulate prior failures
    let mut capture = || Ok(());
    let mut refresh = || Ok(());

    let outcome = run_capture_cycle(&mut capture, &mut refresh, &mut consecutive);

    assert_eq!(outcome, CycleOutcome::Success { attempts_used: 1 });
    assert_eq!(consecutive, 0, "consecutive failures must reset on success");
}

#[test]
fn test_success_on_second_attempt() {
    let call_count = AtomicU32::new(0);
    let mut capture = || {
        let n = call_count.fetch_add(1, Ordering::SeqCst);
        if n == 0 {
            Err("first attempt fails".into())
        } else {
            Ok(())
        }
    };
    let refresh_count = AtomicU32::new(0);
    let mut refresh = || {
        refresh_count.fetch_add(1, Ordering::SeqCst);
        Ok(())
    };
    let mut consecutive = 0;

    let outcome = run_capture_cycle(&mut capture, &mut refresh, &mut consecutive);

    assert_eq!(outcome, CycleOutcome::Success { attempts_used: 2 });
    assert_eq!(consecutive, 0);
    assert_eq!(
        refresh_count.load(Ordering::SeqCst),
        1,
        "refresh should be called once between attempt 0 and 1"
    );
}

#[test]
fn test_success_on_last_retry() {
    let call_count = AtomicU32::new(0);
    let mut capture = || {
        let n = call_count.fetch_add(1, Ordering::SeqCst);
        if n < MAX_CAPTURE_RETRIES {
            Err(format!("attempt {} fails", n))
        } else {
            Ok(()) // succeeds on last retry (attempt == MAX_CAPTURE_RETRIES)
        }
    };
    let refresh_count = AtomicU32::new(0);
    let mut refresh = || {
        refresh_count.fetch_add(1, Ordering::SeqCst);
        Ok(())
    };
    let mut consecutive = 10;

    let outcome = run_capture_cycle(&mut capture, &mut refresh, &mut consecutive);

    assert_eq!(
        outcome,
        CycleOutcome::Success {
            attempts_used: MAX_CAPTURE_RETRIES + 1
        }
    );
    assert_eq!(
        consecutive, 0,
        "consecutive must reset even on last-retry success"
    );
    assert_eq!(
        refresh_count.load(Ordering::SeqCst),
        MAX_CAPTURE_RETRIES,
        "refresh called between each failed attempt (not after the last)"
    );
}

#[test]
fn test_all_retries_fail_increments_consecutive() {
    let mut capture = || Err("always fails".to_string());
    let refresh_count = AtomicU32::new(0);
    let mut refresh = || {
        refresh_count.fetch_add(1, Ordering::SeqCst);
        Ok(())
    };
    let mut consecutive = 0;

    let outcome = run_capture_cycle(&mut capture, &mut refresh, &mut consecutive);

    assert_eq!(
        outcome,
        CycleOutcome::RetryExhausted {
            consecutive_failures: 1
        }
    );
    assert_eq!(consecutive, 1);
    // refresh called between attempts 0→1, 1→2, 2→3, but NOT after attempt 3 (the last)
    assert_eq!(
        refresh_count.load(Ordering::SeqCst),
        MAX_CAPTURE_RETRIES,
        "refresh called exactly MAX_CAPTURE_RETRIES times"
    );
}

#[test]
fn test_bail_after_max_consecutive_failures() {
    let mut capture = || Err("always fails".to_string());
    let mut refresh = || Ok(());
    let mut consecutive = MAX_CONSECUTIVE_FAILURES - 1; // one more will trigger bail

    let outcome = run_capture_cycle(&mut capture, &mut refresh, &mut consecutive);

    assert_eq!(
        outcome,
        CycleOutcome::Bail {
            consecutive_failures: MAX_CONSECUTIVE_FAILURES
        }
    );
    assert_eq!(consecutive, MAX_CONSECUTIVE_FAILURES);
}

#[test]
fn test_exactly_at_threshold_bails() {
    // Verify >= not > in the comparison
    let mut capture = || Err("fail".to_string());
    let mut refresh = || Ok(());
    let mut consecutive = MAX_CONSECUTIVE_FAILURES - 1;

    let outcome = run_capture_cycle(&mut capture, &mut refresh, &mut consecutive);

    // consecutive becomes 30, which is >= 30, so we bail
    assert!(
        matches!(outcome, CycleOutcome::Bail { .. }),
        "must bail at exactly MAX_CONSECUTIVE_FAILURES"
    );
}

#[test]
fn test_one_below_threshold_does_not_bail() {
    let mut capture = || Err("fail".to_string());
    let mut refresh = || Ok(());
    let mut consecutive = MAX_CONSECUTIVE_FAILURES - 2; // will become 29

    let outcome = run_capture_cycle(&mut capture, &mut refresh, &mut consecutive);

    assert_eq!(
        outcome,
        CycleOutcome::RetryExhausted {
            consecutive_failures: MAX_CONSECUTIVE_FAILURES - 1
        }
    );
}

#[test]
fn test_success_after_29_consecutive_failures_resets() {
    let mut consecutive = MAX_CONSECUTIVE_FAILURES - 1; // 29 prior failures
    let mut capture = || Ok(()); // this one succeeds
    let mut refresh = || Ok(());

    let outcome = run_capture_cycle(&mut capture, &mut refresh, &mut consecutive);

    assert_eq!(outcome, CycleOutcome::Success { attempts_used: 1 });
    assert_eq!(
        consecutive, 0,
        "must reset to 0 even at 29 consecutive failures"
    );
}

#[test]
fn test_refresh_failure_does_not_prevent_retry() {
    let call_count = AtomicU32::new(0);
    let mut capture = || {
        let n = call_count.fetch_add(1, Ordering::SeqCst);
        if n == 0 {
            Err("first fails".into())
        } else {
            Ok(())
        }
    };
    // refresh always fails
    let mut refresh = || Err("refresh broken".to_string());
    let mut consecutive = 0;

    let outcome = run_capture_cycle(&mut capture, &mut refresh, &mut consecutive);

    assert_eq!(
        outcome,
        CycleOutcome::Success { attempts_used: 2 },
        "capture should still retry even if refresh fails"
    );
}

#[test]
fn test_total_capture_calls_on_full_failure() {
    let call_count = AtomicU32::new(0);
    let mut capture = || {
        call_count.fetch_add(1, Ordering::SeqCst);
        Err("fail".to_string())
    };
    let mut refresh = || Ok(());
    let mut consecutive = 0;

    let _ = run_capture_cycle(&mut capture, &mut refresh, &mut consecutive);

    assert_eq!(
        call_count.load(Ordering::SeqCst),
        MAX_CAPTURE_RETRIES + 1,
        "should attempt 0..=MAX_CAPTURE_RETRIES = {} total calls",
        MAX_CAPTURE_RETRIES + 1
    );
}

#[test]
fn test_refresh_not_called_on_first_success() {
    let refresh_count = AtomicU32::new(0);
    let mut capture = || Ok(());
    let mut refresh = || {
        refresh_count.fetch_add(1, Ordering::SeqCst);
        Ok(())
    };
    let mut consecutive = 0;

    let _ = run_capture_cycle(&mut capture, &mut refresh, &mut consecutive);

    assert_eq!(
        refresh_count.load(Ordering::SeqCst),
        0,
        "refresh must NOT be called when first attempt succeeds"
    );
}

#[test]
fn test_refresh_not_called_after_last_failed_attempt() {
    // Verify that refresh is NOT called after the final failed attempt
    // (only between retries, not after the last one)
    let call_count = AtomicU32::new(0);
    let refresh_calls = Arc::new(std::sync::Mutex::new(Vec::new()));

    let mut capture = || {
        let n = call_count.fetch_add(1, Ordering::SeqCst);
        Err(format!("attempt {}", n))
    };
    let refresh_calls_clone = refresh_calls.clone();
    let mut refresh = || {
        let n = call_count.load(Ordering::SeqCst);
        refresh_calls_clone.lock().unwrap().push(n);
        Ok(())
    };
    let mut consecutive = 0;

    let _ = run_capture_cycle(&mut capture, &mut refresh, &mut consecutive);

    let calls = refresh_calls.lock().unwrap();
    // refresh is called after attempts 0, 1, 2 (when attempt < MAX_CAPTURE_RETRIES)
    // NOT after attempt 3 (the final one)
    assert_eq!(calls.len(), MAX_CAPTURE_RETRIES as usize);
    // All refresh calls should happen BEFORE the last attempt
    for &call_after_attempt in calls.iter() {
        assert!(
            call_after_attempt <= MAX_CAPTURE_RETRIES,
            "refresh called after attempt {} which is beyond the retry window",
            call_after_attempt
        );
    }
}

#[test]
fn test_30_consecutive_failure_cycles_then_bail() {
    // Simulate the full outer loop: 30 cycles where all retries fail
    let mut capture = || Err("fail".to_string());
    let mut refresh = || Ok(());
    let mut consecutive = 0;

    for cycle in 0..MAX_CONSECUTIVE_FAILURES {
        let outcome = run_capture_cycle(&mut capture, &mut refresh, &mut consecutive);

        if cycle < MAX_CONSECUTIVE_FAILURES - 1 {
            assert_eq!(
                outcome,
                CycleOutcome::RetryExhausted {
                    consecutive_failures: cycle + 1
                },
                "cycle {} should be RetryExhausted",
                cycle
            );
        } else {
            assert_eq!(
                outcome,
                CycleOutcome::Bail {
                    consecutive_failures: MAX_CONSECUTIVE_FAILURES
                },
                "cycle {} should Bail",
                cycle
            );
        }
    }
}

#[test]
fn test_intermittent_failure_never_bails() {
    // Every other cycle fails, but successes reset the counter
    // Should never reach bail threshold
    let cycle_num = AtomicU32::new(0);

    let mut consecutive = 0;
    let mut refresh = || Ok(());

    for _ in 0..100 {
        let n = cycle_num.fetch_add(1, Ordering::SeqCst);
        let mut capture = if n % 2 == 0 {
            Box::new(|| Err("fail".to_string())) as Box<dyn FnMut() -> Result<(), String>>
        } else {
            Box::new(|| Ok(())) as Box<dyn FnMut() -> Result<(), String>>
        };

        let outcome = run_capture_cycle(&mut *capture, &mut refresh, &mut consecutive);

        match outcome {
            CycleOutcome::Bail { .. } => {
                panic!("should never bail with alternating success/failure");
            }
            CycleOutcome::Success { .. } => {
                assert_eq!(consecutive, 0);
            }
            CycleOutcome::RetryExhausted {
                consecutive_failures,
            } => {
                assert!(
                    consecutive_failures < MAX_CONSECUTIVE_FAILURES,
                    "consecutive failures should stay low with intermittent success"
                );
            }
        }
    }
}

#[test]
fn test_recovery_at_failure_29_prevents_bail() {
    // 29 consecutive failure cycles, then one success, then 29 more failures
    // Should never bail
    let mut capture_fails = || Err("fail".to_string());
    let mut capture_succeeds = || Ok(());
    let mut refresh = || Ok(());
    let mut consecutive = 0;

    // 29 failure cycles
    for _ in 0..(MAX_CONSECUTIVE_FAILURES - 1) {
        let outcome = run_capture_cycle(&mut capture_fails, &mut refresh, &mut consecutive);
        assert!(matches!(outcome, CycleOutcome::RetryExhausted { .. }));
    }
    assert_eq!(consecutive, MAX_CONSECUTIVE_FAILURES - 1);

    // One success resets everything
    let outcome = run_capture_cycle(&mut capture_succeeds, &mut refresh, &mut consecutive);
    assert_eq!(outcome, CycleOutcome::Success { attempts_used: 1 });
    assert_eq!(consecutive, 0);

    // 29 more failure cycles — still shouldn't bail
    for i in 0..(MAX_CONSECUTIVE_FAILURES - 1) {
        let outcome = run_capture_cycle(&mut capture_fails, &mut refresh, &mut consecutive);
        assert_eq!(
            outcome,
            CycleOutcome::RetryExhausted {
                consecutive_failures: i + 1
            }
        );
    }
    assert_eq!(consecutive, MAX_CONSECUTIVE_FAILURES - 1);
}

// =============================================================================
// Tests for the index migration SQL
// =============================================================================

#[test]
fn test_index_migration_sql_is_valid() {
    // Verify the migration SQL parses correctly
    let sql = include_str!(
        "../../screenpipe-db/src/migrations/20260207000000_index_video_chunks_device_name.sql"
    );

    // Should contain exactly 2 CREATE INDEX statements
    let create_count = sql.matches("CREATE INDEX").count();
    assert_eq!(
        create_count, 2,
        "migration should have exactly 2 CREATE INDEX statements"
    );

    // Should use IF NOT EXISTS (idempotent)
    let if_not_exists_count = sql.matches("IF NOT EXISTS").count();
    assert_eq!(
        if_not_exists_count, 2,
        "both indexes should use IF NOT EXISTS"
    );

    // Should target video_chunks table
    assert!(
        sql.contains("ON video_chunks"),
        "indexes should be on video_chunks table"
    );

    // Should index device_name column
    assert!(
        sql.contains("(device_name)"),
        "should have single-column index on device_name"
    );

    // Should have compound index for the exact query pattern
    assert!(
        sql.contains("(device_name, id DESC)"),
        "should have compound index matching ORDER BY id DESC"
    );
}
