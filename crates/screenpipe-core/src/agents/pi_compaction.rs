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

fn patched_source(source: &str) -> Result<Option<String>> {
    if source.contains(MARKER) {
        return Ok(None);
    }
    let patch = diffy::Patch::from_str(PATCH).context("invalid bundled Pi compaction patch")?;
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
    let Some(patched) = patched_source(&source)? else {
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
        assert!(patched_source(MARKER).unwrap().is_none());
    }

    #[test]
    fn unknown_runtime_is_rejected_without_writing() {
        let dir = tempfile::tempdir().unwrap();
        let runtime = dir
            .path()
            .join("node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js");
        std::fs::create_dir_all(runtime.parent().unwrap()).unwrap();
        std::fs::write(&runtime, "unrecognized runtime").unwrap();
        assert!(ensure(dir.path()).is_err());
        assert_eq!(
            std::fs::read_to_string(runtime).unwrap(),
            "unrecognized runtime"
        );
    }
}
