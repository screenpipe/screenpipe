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
static PATCH_LOCK: Mutex<()> = Mutex::new(());

pub fn ensure_for_entrypoint(entrypoint: &Path) -> Result<()> {
    let install_dir = crate::paths::default_screenpipe_data_dir().join("pi-agent");
    if entrypoint.starts_with(&install_dir) {
        ensure(&install_dir)?;
    }
    Ok(())
}

fn patched_source(source: &str, patch: &str) -> Result<Option<String>> {
    if source.contains(MARKER) {
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
    let runtime =
        install_dir.join("node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js");
    let source = std::fs::read_to_string(&runtime).context("cannot read managed Pi runtime")?;
    let Some(patched) = patched_source(&source, PATCH)? else {
        return Ok(());
    };
    let mut output = tempfile::NamedTempFile::new_in(runtime.parent().unwrap())?;
    output.write_all(patched.as_bytes())?;
    output.as_file().sync_all()?;
    output
        .persist(&runtime)
        .context("cannot save managed Pi compaction fix")?;
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
        let lf = PATCH.replace("\r\n", "\n");
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
