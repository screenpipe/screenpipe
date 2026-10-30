// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Runtime policy selection, independent of installer identity. Selecting managed
//! mode never grants access: native policy and seat verification still own that.

use crate::store::SettingsStore;
use once_cell::sync::Lazy;
use std::sync::atomic::{AtomicBool, Ordering};

// Deployment configuration is immutable for a process. User/account state is
// read live so sign-in can enter managed mode without restarting the app.
static MANAGED_SESSION: AtomicBool = AtomicBool::new(false);

static MANAGED_DEPLOYMENT: Lazy<bool> = Lazy::new(|| {
    let config = crate::commands::get_enterprise_file_config();
    config.license_key.is_some()
        || config.ingest_url.is_some()
        || [
            "SCREENPIPE_ENTERPRISE_LICENSE_KEY",
            "SCREENPIPE_ENTERPRISE_INGEST_URL",
        ]
        .iter()
        .any(|name| std::env::var(name).is_ok_and(|value| !value.trim().is_empty()))
        || has_managed_config_marker()
});

// Credential parsing may fail, but an invalid provisioned file must never
// silently downgrade a managed deployment to personal authentication.
fn has_managed_config_marker() -> bool {
    let mut paths =
        vec![screenpipe_core::paths::default_screenpipe_data_dir().join("enterprise.json")];
    let Ok(exe) = std::env::current_exe() else {
        return true;
    };
    if let Some(dir) = exe.parent() {
        paths.push(dir.join("enterprise.json"));
        #[cfg(target_os = "macos")]
        paths.push(dir.join("../Resources/enterprise.json"));
    }
    paths
        .iter()
        .any(|path| match std::fs::read_to_string(path) {
            Ok(raw) => match serde_json::from_str::<serde_json::Value>(&raw) {
                Ok(serde_json::Value::Object(fields)) => {
                    fields.contains_key("license_key") || fields.contains_key("ingest_url")
                }
                Ok(_) | Err(_) => true,
            },
            Err(error) => error.kind() != std::io::ErrorKind::NotFound,
        })
}

pub(crate) fn deployment_or_session_is_managed() -> bool {
    crate::package_identity::is_enterprise()
        || *MANAGED_DEPLOYMENT
        || MANAGED_SESSION.load(Ordering::SeqCst)
}

pub(crate) fn for_settings(settings: &SettingsStore) -> bool {
    resolve_mode(
        &MANAGED_SESSION,
        crate::package_identity::is_enterprise(),
        *MANAGED_DEPLOYMENT,
        settings,
    )
}

fn resolve_mode(
    session: &AtomicBool,
    legacy: bool,
    deployment: bool,
    settings: &SettingsStore,
) -> bool {
    let managed = legacy || deployment || settings.requires_enterprise_app_for_consumer();
    // Signing out revokes credentials, never the process's managed policy.
    session.fetch_or(managed, Ordering::SeqCst) || managed
}

pub(crate) fn is_managed(app: &tauri::AppHandle) -> bool {
    match SettingsStore::get(app) {
        Ok(Some(settings)) => for_settings(&settings),
        Ok(None) => {
            MANAGED_SESSION.load(Ordering::SeqCst)
                || crate::package_identity::is_enterprise()
                || *MANAGED_DEPLOYMENT
        }
        // A failed store read cannot downgrade managed enforcement.
        Err(_) => true,
    }
}

#[cfg(test)]
mod tests {
    use super::resolve_mode;
    use crate::store::SettingsStore;
    use serde_json::json;
    use std::sync::atomic::AtomicBool;

    #[test]
    fn sign_in_enters_managed_mode_and_sign_out_cannot_downgrade_it() {
        let session = AtomicBool::new(false);
        let mut settings = SettingsStore::default();
        assert!(!resolve_mode(&session, false, false, &settings));
        settings.user.enterprise_account = Some(json!({"requires_enterprise_app": true}));
        assert!(resolve_mode(&session, false, false, &settings));
        settings.user = Default::default();
        assert!(resolve_mode(&session, false, false, &settings));
    }

    #[test]
    fn legacy_and_managed_deployments_require_policy_without_an_account() {
        let settings = SettingsStore::default();
        for (legacy, deployment) in [(true, false), (false, true), (true, true)] {
            assert!(resolve_mode(
                &AtomicBool::new(false),
                legacy,
                deployment,
                &settings
            ));
        }
    }

    #[test]
    fn personal_subscription_is_an_opt_out_only_when_the_org_permits_it() {
        let mut settings = SettingsStore::default();
        settings.user.id = Some("personal-subscriber".into());
        settings.user.app_entitled = Some(true);
        settings.user.subscription_plan = Some("standard".into());
        settings.user.enterprise_account = Some(json!({"requires_enterprise_app": true}));
        settings.user.entitlement = Some(json!({
            "active": true, "plan": "standard", "source": "subscription",
            "checked_at": chrono::Utc::now().to_rfc3339(), "features": {"app": true}
        }));
        assert!(!resolve_mode(
            &AtomicBool::new(false),
            false,
            false,
            &settings
        ));
        settings.user.enterprise_account = Some(json!({
            "requires_enterprise_app": true, "restrict_consumer_build_access": true
        }));
        assert!(resolve_mode(
            &AtomicBool::new(false),
            false,
            false,
            &settings
        ));
    }

    #[test]
    #[cfg(not(target_os = "windows"))]
    fn deployment_sources_are_resolved_in_isolated_processes() {
        // Each process gets fresh deployment/session statics and a task-owned
        // data directory. No test reads or changes the installed user's store.
        for (name, file, key, ingest, expected) in [
            ("personal", None, "", "", false),
            ("blank environment", None, "  ", "  ", false),
            ("environment license", None, "fixture-license", "", true),
            (
                "environment control plane",
                None,
                "",
                "https://control.test/ingest",
                true,
            ),
            (
                "file license",
                Some(r#"{"license_key":"fixture-license"}"#),
                "",
                "",
                true,
            ),
            (
                "file control plane",
                Some(r#"{"ingest_url":"https://control.test/ingest"}"#),
                "",
                "",
                true,
            ),
            (
                "unrelated metadata",
                Some(r#"{"is_enterprise_admin":false}"#),
                "",
                "",
                false,
            ),
            (
                "blank managed key",
                Some(r#"{"license_key":" "}"#),
                "",
                "",
                true,
            ),
            (
                "wrong key type",
                Some(r#"{"license_key":123}"#),
                "",
                "",
                true,
            ),
            ("malformed managed file", Some("{broken"), "", "", true),
            ("invalid root type", Some("[]"), "", "", true),
        ] {
            let root = tempfile::tempdir().unwrap();
            if let Some(file) = file {
                std::fs::write(root.path().join("enterprise.json"), file).unwrap();
            }
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "app_mode::tests::isolated_mode_probe",
                    "--ignored",
                    "--nocapture",
                ])
                .env("SCREENPIPE_DATA_DIR", root.path())
                .env("SCREENPIPE_ENTERPRISE_LICENSE_KEY", key)
                .env("SCREENPIPE_ENTERPRISE_INGEST_URL", ingest)
                .env("SCREENPIPE_TEST_MANAGED_MODE", expected.to_string())
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{name}: {}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
        }
    }

    #[test]
    #[ignore = "subprocess probe driven by the deployment matrix"]
    fn isolated_mode_probe() {
        let Ok(expected) = std::env::var("SCREENPIPE_TEST_MANAGED_MODE") else {
            return;
        };
        assert_eq!(
            super::for_settings(&SettingsStore::default()),
            expected == "true"
        );
        assert!(
            !crate::enterprise_policy::recording_authorized(),
            "selecting managed mode must not grant recording authorization"
        );
    }
}
