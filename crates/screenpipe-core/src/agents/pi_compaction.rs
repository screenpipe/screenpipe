// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Backport context compaction fixes to Screenpipe's pinned Pi runtime.
//! Apply atomically before launch; never patch a user's global Pi installation.

use anyhow::{anyhow, Context, Result};
use std::io::Write;
use std::path::Path;
use std::sync::Mutex;

const PATCH: &str = include_str!("../../assets/pi-context-compaction.patch");
const MARKER: &str = "// screenpipe-context-compaction-v1\n";
const EVIDENCE_PATCH: &str = include_str!("../../assets/pi-summary-evidence.patch");
const EVIDENCE_MARKER: &str = "// screenpipe-summary-evidence-v1\n";
const VALIDATION_PATCH: &str = include_str!("../../assets/pi-summary-validation.patch");
const VALIDATION_MARKER: &str = "// screenpipe-summary-validation-v1\n";
const CONTRACT_PATCH: &str = include_str!("../../assets/pi-summary-contract.patch");
const CONTRACT_MARKER: &str = "// screenpipe-summary-contract-v1\n";
const FAILURE_PATCH: &str = include_str!("../../assets/pi-compaction-failure.patch");
const FAILURE_MARKER: &str = "// screenpipe-compaction-failure-v1\n";
static PATCH_LOCK: Mutex<()> = Mutex::new(());

pub fn ensure_for_entrypoint(entrypoint: &Path) -> Result<()> {
    let install_dir = crate::paths::default_screenpipe_data_dir().join("pi-agent");
    if entrypoint.starts_with(&install_dir) {
        ensure(&install_dir)?;
    }
    Ok(())
}

#[cfg(test)]
fn patched_source(source: &str, patch: &str) -> Result<Option<String>> {
    patched_source_with_marker(source, patch, MARKER)
}

fn patched_source_with_marker(source: &str, patch: &str, marker: &str) -> Result<Option<String>> {
    if source.contains(marker) {
        return Ok(None);
    }
    // Windows checkouts can embed CRLF in this asset. diffy requires LF in
    // patch headers, and the package-manager-installed JS runtime also uses LF.
    let patch = patch.replace("\r\n", "\n");
    let patch = diffy::Patch::from_str(&patch)
        .map_err(|error| anyhow!("invalid bundled Pi compaction patch: {error}"))?;
    diffy::apply(source, &patch)
        .map(Some)
        .map_err(|error| anyhow!("Pi runtime does not match the pinned compaction patch: {error}"))
}

/// `install_dir` is the app-owned `pi-agent` directory, never a global package.
pub fn ensure(install_dir: &Path) -> Result<()> {
    let _guard = PATCH_LOCK
        .lock()
        .map_err(|_| anyhow!("Pi patch lock poisoned"))?;
    let core = install_dir.join("node_modules/@earendil-works/pi-coding-agent/dist/core");
    // Preflight all pinned files before writing any. Each replacement is
    // atomic; an interrupted install is completed idempotently on next launch.
    let mut updates = Vec::new();
    for (file, patches) in [
        (
            "agent-session.js",
            &[(PATCH, MARKER), (FAILURE_PATCH, FAILURE_MARKER)][..],
        ),
        (
            "compaction/utils.js",
            &[
                (EVIDENCE_PATCH, EVIDENCE_MARKER),
                (CONTRACT_PATCH, CONTRACT_MARKER),
            ][..],
        ),
        (
            "compaction/compaction.js",
            &[(VALIDATION_PATCH, VALIDATION_MARKER)][..],
        ),
    ] {
        let runtime = core.join(file);
        let source = std::fs::read_to_string(&runtime).context("cannot read managed Pi runtime")?;
        let mut patched = source.clone();
        for (patch, marker) in patches {
            if let Some(next) = patched_source_with_marker(&patched, patch, marker)? {
                patched = next;
            }
        }
        if patched != source {
            updates.push((runtime, patched));
        }
    }
    for (runtime, patched) in updates {
        let mut output = tempfile::NamedTempFile::new_in(runtime.parent().unwrap())?;
        output.write_all(patched.as_bytes())?;
        output.as_file().sync_all()?;
        output
            .persist(&runtime)
            .context("cannot save managed Pi compaction fix")?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn already_patched_runtime_is_unchanged() {
        assert!(patched_source(MARKER, PATCH).unwrap().is_none());
    }

    #[test]
    fn bundled_patch_parses_with_lf_and_crlf() {
        for asset in [
            PATCH,
            EVIDENCE_PATCH,
            VALIDATION_PATCH,
            CONTRACT_PATCH,
            FAILURE_PATCH,
        ] {
            let lf = asset.replace("\r\n", "\n");
            for patch in [&lf, &lf.replace('\n', "\r\n")] {
                // An unknown runtime must fail application, not parsing. Windows
                // checkouts can give include_str! a CRLF copy of the real asset.
                let error = patched_source("unrecognized runtime", patch).unwrap_err();
                assert!(
                    error
                        .to_string()
                        .starts_with("Pi runtime does not match the pinned compaction patch:"),
                    "{error:#}"
                );
            }
        }
    }

    #[test]
    fn evidence_marker_does_not_skip_an_unpatched_serializer() {
        assert!(patched_source_with_marker(MARKER, EVIDENCE_PATCH, EVIDENCE_MARKER).is_err());
        assert!(
            patched_source_with_marker(EVIDENCE_MARKER, EVIDENCE_PATCH, EVIDENCE_MARKER)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn prior_markers_do_not_skip_follow_up_patches() {
        assert!(
            patched_source_with_marker(EVIDENCE_MARKER, CONTRACT_PATCH, CONTRACT_MARKER).is_err()
        );
        assert!(patched_source_with_marker(MARKER, FAILURE_PATCH, FAILURE_MARKER).is_err());
        assert!(
            patched_source_with_marker(CONTRACT_MARKER, CONTRACT_PATCH, CONTRACT_MARKER)
                .unwrap()
                .is_none()
        );
        assert!(
            patched_source_with_marker(FAILURE_MARKER, FAILURE_PATCH, FAILURE_MARKER)
                .unwrap()
                .is_none()
        );
    }

    #[test]
    fn unknown_serializer_is_rejected_even_after_session_patch() {
        let dir = tempfile::tempdir().unwrap();
        let core = dir
            .path()
            .join("node_modules/@earendil-works/pi-coding-agent/dist/core");
        std::fs::create_dir_all(core.join("compaction")).unwrap();
        let session = format!("{MARKER}{FAILURE_MARKER}");
        std::fs::write(core.join("agent-session.js"), &session).unwrap();
        std::fs::write(core.join("compaction/utils.js"), "unknown serializer").unwrap();
        assert!(ensure(dir.path()).is_err());
        assert_eq!(
            std::fs::read_to_string(core.join("agent-session.js")).unwrap(),
            session
        );
        assert_eq!(
            std::fs::read_to_string(core.join("compaction/utils.js")).unwrap(),
            "unknown serializer"
        );
    }

    #[test]
    fn crlf_patch_applies_to_lf_runtime_and_remains_idempotent() {
        let source = "const original = true;\n";
        let expected = format!("{MARKER}const original = false;\n");
        let patch = diffy::create_patch(source, &expected)
            .to_string()
            .replace('\n', "\r\n");
        let patched = patched_source(source, &patch).unwrap().unwrap();
        assert_eq!(patched, expected);
        assert!(patched_source(&patched, &patch).unwrap().is_none());
    }

    #[test]
    fn invalid_patch_preserves_parser_cause_in_display() {
        let error = patched_source("unrecognized runtime", "--- unterminated").unwrap_err();
        assert_eq!(
            error.to_string(),
            "invalid bundled Pi compaction patch: error parsing patch: filename unterminated"
        );
    }

    #[test]
    fn unknown_runtime_is_rejected_without_writing() {
        let dir = tempfile::tempdir().unwrap();
        let runtime = dir
            .path()
            .join("node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js");
        std::fs::create_dir_all(runtime.parent().unwrap()).unwrap();
        std::fs::write(&runtime, "unrecognized runtime").unwrap();
        let error = ensure(dir.path()).unwrap_err();
        assert!(error
            .to_string()
            .starts_with("Pi runtime does not match the pinned compaction patch:"));
        assert_eq!(
            std::fs::read_to_string(runtime).unwrap(),
            "unrecognized runtime"
        );
    }
}
