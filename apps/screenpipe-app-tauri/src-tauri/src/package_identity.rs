// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Package metadata allows one compiled executable to retain either installer's
//! identity, update transport and protocol registration. Authorization remains in
//! app_mode and the native policy/seat checks.

use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

pub(crate) const METADATA_FILE: &str = "screenpipe-package.json";

#[derive(Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct PackageIdentity {
    pub identifier: String,
    pub product_name: String,
    pub version: String,
    pub updater: serde_json::Value,
    pub deep_link: serde_json::Value,
}

impl PackageIdentity {
    fn validate(&self, version: &str) -> Result<(), String> {
        if self.identifier != "screenpi.pe.enterprise"
            || self.product_name != "screenpipe enterprise"
            || self.version != version
        {
            return Err(format!("incompatible package metadata: identifier={} product={} version={} executable_version={version}", self.identifier, self.product_name, self.version));
        }
        let expected: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.enterprise.conf.json"))
                .map_err(|error| error.to_string())?;
        if self.updater != expected["plugins"]["updater"]
            || self.deep_link != expected["plugins"]["deep-link"]
        {
            return Err("package updater or deep-link configuration does not match the signed application contract".into());
        }
        Ok(())
    }
}

fn load(paths: &[PathBuf], version: Option<&str>) -> Result<Option<PackageIdentity>, String> {
    let mut found = None;
    for path in paths {
        let bytes = match std::fs::read(path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(format!("read {}: {error}", path.display())),
        };
        if found.is_some() {
            return Err("multiple package identities found beside this executable".into());
        }
        let identity: PackageIdentity = serde_json::from_slice(&bytes)
            .map_err(|error| format!("parse {}: {error}", path.display()))?;
        identity.validate(version.unwrap_or(&identity.version))?;
        found = Some(identity);
    }
    Ok(found)
}

fn metadata_paths(executable: &Path) -> Vec<PathBuf> {
    let Some(dir) = executable.parent() else {
        return Vec::new();
    };
    #[cfg(target_os = "macos")]
    return vec![dir.join("../Resources").join(METADATA_FILE)];
    #[cfg(target_os = "windows")]
    return vec![dir.join(METADATA_FILE)];
    #[cfg(target_os = "linux")]
    {
        let mut paths = vec![dir.join(METADATA_FILE)];
        // The Enterprise Linux bundle has its own executable entry point, so
        // a standard install cannot pick up another package's /usr/lib files.
        if executable
            .file_name()
            .is_some_and(|name| name == "screenpipe-enterprise")
        {
            paths.push(dir.join("../lib/screenpipe enterprise").join(METADATA_FILE));
        }
        paths
    }
}

pub(crate) fn initialize(
    mut context: tauri::Context<tauri::Wry>,
) -> Result<tauri::Context<tauri::Wry>, String> {
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let identity = load(
        &metadata_paths(&executable),
        Some(&context.package_info().version.to_string()),
    )?;
    #[cfg(target_os = "macos")]
    if let Some(parent) = executable.parent() {
        let plist = parent.join("../Info.plist");
        if plist.exists() {
            let info = plist::Value::from_file(&plist)
                .map_err(|error| format!("read {}: {error}", plist.display()))?;
            let native_identifier = info
                .as_dictionary()
                .and_then(|info| info.get("CFBundleIdentifier"))
                .and_then(plist::Value::as_string);
            let declared_identifier = identity
                .as_ref()
                .map(|identity| identity.identifier.as_str())
                .unwrap_or(&context.config().identifier);
            if native_identifier == Some("screenpi.pe.enterprise")
                && declared_identifier != "screenpi.pe.enterprise"
            {
                return Err("Enterprise bundle is missing matching package metadata; refusing personal fallback".into());
            }
            if identity.is_some() && native_identifier != Some(declared_identifier) {
                return Err("native bundle identifier differs from its package metadata".into());
            }
        }
    }
    if let Some(identity) = identity {
        context.package_info_mut().name = identity.product_name.clone();
        let config = context.config_mut();
        config.identifier = identity.identifier;
        config.product_name = Some(identity.product_name);
        config.plugins.0.insert("updater".into(), identity.updater);
        config
            .plugins
            .0
            .insert("deep-link".into(), identity.deep_link);
    }
    screenpipe_config::initialize_package_identity(&context.config().identifier)
        .map_err(str::to_string)?;
    Ok(context)
}

pub(crate) fn product_name_for(executable: &Path) -> Result<Option<String>, String> {
    Ok(load(&metadata_paths(executable), None)?.map(|identity| identity.product_name))
}

pub(crate) fn is_enterprise() -> bool {
    screenpipe_config::is_enterprise_package()
}

pub(crate) fn record_failure(root: &Path, cause: &str) {
    crate::update_diagnostics::append(
        root,
        "package_identity_failed",
        &format!(
            "cause={cause}; outcome=startup_aborted; recovery=restore_matching_signed_package"
        ),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity(version: &str) -> PackageIdentity {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.enterprise.conf.json")).unwrap();
        PackageIdentity {
            identifier: config["identifier"].as_str().unwrap().into(),
            product_name: config["productName"].as_str().unwrap().into(),
            version: version.into(),
            updater: config["plugins"]["updater"].clone(),
            deep_link: config["plugins"]["deep-link"].clone(),
        }
    }

    #[test]
    fn shared_executable_accepts_matching_legacy_package_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join(METADATA_FILE);
        assert!(load(&[path.clone()], Some("2.7.124")).unwrap().is_none());
        std::fs::write(&path, serde_json::to_vec(&identity("2.7.124")).unwrap()).unwrap();
        assert_eq!(
            load(&[path.clone()], Some("2.7.124"))
                .unwrap()
                .unwrap()
                .identifier,
            "screenpi.pe.enterprise"
        );
        assert!(load(&[path.clone()], Some("2.7.123"))
            .unwrap_err()
            .contains("executable_version"));
        let mut wrong = identity("2.7.124");
        wrong.updater["endpoints"] = serde_json::json!(["https://example.invalid/update"]);
        std::fs::write(&path, serde_json::to_vec(&wrong).unwrap()).unwrap();
        assert!(load(&[path.clone()], Some("2.7.124"))
            .unwrap_err()
            .contains("updater"));
        std::fs::write(&path, "{").unwrap();
        assert!(load(&[path], Some("2.7.124"))
            .unwrap_err()
            .contains("parse"));
    }

    #[test]
    fn one_executable_obeys_both_package_contracts_in_fresh_processes() {
        use std::process::Command;
        let current = std::env::current_exe().unwrap();
        for enterprise in [false, true] {
            let dir = tempfile::tempdir().unwrap();
            #[cfg(target_os = "macos")]
            let binary_dir = dir.path().join("screenpipe.app/Contents/MacOS");
            #[cfg(not(target_os = "macos"))]
            let binary_dir = dir.path().join("bin");
            std::fs::create_dir_all(&binary_dir).unwrap();
            let executable = binary_dir.join(current.file_name().unwrap());
            std::fs::copy(&current, &executable).unwrap();
            if enterprise {
                let path = metadata_paths(&executable).remove(0);
                std::fs::create_dir_all(path.parent().unwrap()).unwrap();
                std::fs::write(
                    path,
                    serde_json::to_vec(&identity(env!("CARGO_PKG_VERSION"))).unwrap(),
                )
                .unwrap();
            }
            let mut child = Command::new(&executable);
            child
                .args([
                    "--exact",
                    "package_identity::tests::isolated_package_probe",
                    "--ignored",
                    "--nocapture",
                ])
                .env(
                    "SCREENPIPE_TEST_EXPECT_ENTERPRISE_PACKAGE",
                    enterprise.to_string(),
                )
                .env("SCREENPIPE_DATA_DIR", dir.path().join("data"))
                .env_remove("SCREENPIPE_ENTERPRISE_LICENSE_KEY")
                .env_remove("SCREENPIPE_ENTERPRISE_INGEST_URL");
            #[cfg(target_os = "windows")]
            {
                let mut paths = vec![current.parent().unwrap().to_path_buf()];
                paths.extend(std::env::split_paths(
                    &std::env::var_os("PATH").unwrap_or_default(),
                ));
                child.env("PATH", std::env::join_paths(paths).unwrap());
            }
            let result = child.output().unwrap();
            assert!(
                result.status.success(),
                "{}\n{}",
                String::from_utf8_lossy(&result.stdout),
                String::from_utf8_lossy(&result.stderr)
            );
        }
    }

    #[test]
    #[ignore = "invoked in fresh processes by one_executable_obeys_both_package_contracts_in_fresh_processes"]
    fn isolated_package_probe() {
        let enterprise =
            std::env::var("SCREENPIPE_TEST_EXPECT_ENTERPRISE_PACKAGE").unwrap() == "true";
        let context = initialize(tauri::generate_context!()).unwrap();
        assert_eq!(is_enterprise(), enterprise);
        assert_eq!(
            context.config().identifier == "screenpi.pe.enterprise",
            enterprise
        );
        assert_eq!(
            crate::deep_link::scheme(),
            if enterprise {
                "screenpipe-enterprise"
            } else {
                "screenpipe"
            }
        );
        let settings = crate::store::SettingsStore::default();
        // Desktop settings enable text PII removal in both packages; the
        // shared recording defaults retain the package-specific fallback.
        assert!(settings.recording.use_pii_removal);
        assert_eq!(
            screenpipe_config::RecordingSettings::default().use_pii_removal,
            enterprise
        );
        assert_eq!(settings.recording.async_pii_redaction, enterprise);
        assert_eq!(settings.recording.disable_keyboard_capture, !enterprise);
        assert_eq!(
            settings.recording.pii_backend,
            if enterprise { "tinfoil" } else { "local" }
        );
        assert_eq!(crate::app_mode::for_settings(&settings), enterprise);
        assert!(!crate::enterprise_policy::recording_authorized());
        if enterprise {
            assert_eq!(context.package_info().name, "screenpipe enterprise");
            assert_eq!(context.config().plugins.0["updater"]["endpoints"][0], "https://screenpipe.com/api/app-update/enterprise/{{target}}-{{arch}}/{{current_version}}");
        }
    }
}
