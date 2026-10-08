// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! A deliberate launch selects a build before either single-instance path runs.
//! The private socket authenticates the connecting process, never a supplied PID.

use serde::{Deserialize, Serialize};
use std::path::PathBuf;

const PROTOCOL: u32 = 1;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct Identity {
    pid: i32,
    started: u64,
    uid: u32,
    identifier: String,
    version: String,
    hash: String,
    executable: PathBuf,
}

#[derive(Debug, PartialEq, Eq)]
enum Selection {
    Focus,
    Replace,
    Reject,
}

fn select(current: &Identity, candidate: &Identity) -> Selection {
    if current.uid != candidate.uid || current.identifier != candidate.identifier {
        return Selection::Reject;
    }
    if current.hash == candidate.hash {
        return Selection::Focus;
    }
    match (
        semver::Version::parse(&current.version),
        semver::Version::parse(&candidate.version),
    ) {
        (Ok(mut old), Ok(mut new)) => {
            old.build = semver::BuildMetadata::EMPTY;
            new.build = semver::BuildMetadata::EMPTY;
            if new >= old {
                Selection::Replace
            } else {
                Selection::Reject
            }
        }
        _ => Selection::Reject,
    }
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    protocol: u32,
    replace: bool,
}

#[derive(Serialize, Deserialize)]
struct Response {
    protocol: u32,
    identity: Identity,
    outcome: String,
    error: Option<String>,
}

fn report_failure(root: &std::path::Path, stage: &str, error: &str) {
    crate::update_diagnostics::append(
        root,
        "manual_handoff_failed",
        &format!("stage={stage}; cause={error}; outcome=selected_copy_not_started"),
    );
}

#[cfg(target_os = "macos")]
mod macos;
#[cfg(target_os = "macos")]
pub(crate) use macos::{initialize, install, owns_launch, pending, reopen};

#[cfg(test)]
mod tests {
    use super::*;

    fn build(version: &str, hash: &str) -> Identity {
        Identity {
            pid: 10,
            started: 20,
            uid: 501,
            identifier: "screenpi.pe".into(),
            version: version.into(),
            hash: hash.into(),
            executable: "/Applications/screenpipe.app/Contents/MacOS/screenpipe-app".into(),
        }
    }

    #[test]
    fn file_identity_not_path_selects_replacement() {
        let old = build("2.7.95", "old");
        assert_eq!(select(&old, &old), Selection::Focus);
        assert_eq!(select(&old, &build("2.7.96", "new")), Selection::Replace);
        assert_eq!(
            select(&old, &build("2.7.95", "rebuilt")),
            Selection::Replace
        );
        let mut copied = old.clone();
        copied.executable = "/Volumes/download/screenpipe.app/Contents/MacOS/screenpipe-app".into();
        assert_eq!(select(&old, &copied), Selection::Focus);
        copied.hash = "new".into();
        assert_eq!(select(&old, &copied), Selection::Replace);
    }

    #[test]
    fn downgrades_unknown_versions_users_and_editions_cannot_take_over() {
        let old = build("2.7.95", "old");
        for version in ["2.7.94", "unknown", "2.7.95-beta.1"] {
            assert_eq!(select(&old, &build(version, "other")), Selection::Reject);
        }
        for edition in [
            "screenpi.pe.beta",
            "screenpi.pe.enterprise",
            "screenpi.pe.dev",
        ] {
            let mut new = build("2.7.96", "new");
            new.identifier = edition.into();
            assert_eq!(select(&old, &new), Selection::Reject);
        }
        let mut other_user = build("2.7.96", "new");
        other_user.uid += 1;
        assert_eq!(select(&old, &other_user), Selection::Reject);
    }

    #[tokio::test]
    async fn failure_survives_rotation_and_support_redaction() {
        let root = tempfile::tempdir().unwrap();
        report_failure(
            root.path(),
            "drain",
            "database shutdown timed out for private-person@example.com",
        );
        std::fs::write(
            root.path().join(crate::update_diagnostics::RECOVERY_LOG_NAME),
            "manual_recovery: stage=recovery_validation; cause=Verify app signature: code signature invalid (-67054); target=private-person@example.com; outcome=selected_copy_not_started\n",
        ).unwrap();
        for day in 1..=7 {
            std::fs::write(
                root.path()
                    .join(format!("screenpipe-app.2026-10-{day:02}.log")),
                "restart\n",
            )
            .unwrap();
        }
        let report = crate::diagnostic_logs::collect_redacted_from_dirs(&[root.path().into()])
            .await
            .unwrap();
        assert!(report.contains("manual_handoff_failed"));
        assert!(report.contains("database shutdown timed out"));
        assert!(report.contains("selected_copy_not_started"));
        assert!(report.contains("manual_recovery"));
        assert!(report.contains("code signature invalid (-67054)"));
        assert!(!report.contains("private-person@example.com"));
    }

    /// Run only against a disposable guest after a real failed Finder launch.
    /// Exports the same redacted payload used by authorized support collection.
    #[tokio::test]
    #[ignore = "requires a real failed handoff in a disposable macOS guest"]
    async fn collect_vm_failure_for_support() {
        let root = std::env::var_os("HANDOFF_TEST_LOG_DIR").expect("guest log directory");
        let output = std::env::var_os("HANDOFF_TEST_REPORT").expect("redacted report destination");
        let report = crate::diagnostic_logs::collect_redacted_from_dirs(&[root.into()])
            .await
            .unwrap();
        let expected_cause = std::env::var("HANDOFF_TEST_EXPECTED_CAUSE")
            .unwrap_or_else(|_| "cannot authenticate the legacy search API".into());
        let evidence = [
            "manual_handoff_candidate",
            "source=",
            "target=",
            "manual_handoff_failed",
            expected_cause.as_str(),
            "selected_copy_not_started",
        ];
        for evidence in evidence {
            assert!(report.contains(evidence), "support report lost {evidence}");
        }
        std::fs::write(output, report).unwrap();
    }
}
