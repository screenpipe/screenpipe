// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Durable storage for the xdg-desktop-portal ScreenCast restore token.
//!
//! The ScreenCast portal hands back a `restore_token` after the user approves
//! a screen-share dialog. Passing that token to the next `SelectSources` call
//! lets the compositor restore the same selection without prompting again.
//!
//! Screenpipe previously kept the token only in memory and asked for
//! `PersistMode::Application`, so every app restart (and every login) showed
//! the dialog again. This module persists the token under the screenpipe data
//! directory so the capture session can pair it with
//! `PersistMode::ExplicitlyRevoked` and survive restarts.
//!
//! The token is a capability: whoever presents it may restart the same screen
//! share. It is therefore written with owner-only permissions (`0600`) through
//! a temp-file-and-rename so a crash never leaves a truncated token behind.
//! Anything that does not look like a token (empty, oversized, or containing
//! control characters) is treated as absent rather than sent to the portal.

use std::{
    fs,
    io::{self, Write},
    os::unix::fs::{OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
};

/// File name of the persisted token inside the screenpipe data directory.
pub(super) const RESTORE_TOKEN_FILE_NAME: &str = "wayland-screencast-restore-token";

/// Upper bound on an accepted token. Portal backends issue UUID-sized tokens
/// (KDE and GNOME both use 36 characters); anything far larger is corrupt.
const MAX_TOKEN_LEN: usize = 512;

/// Reads, writes and clears the persisted ScreenCast restore token.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct RestoreTokenStore {
    path: PathBuf,
}

impl RestoreTokenStore {
    /// Store backed by an explicit file path.
    pub(super) fn new(path: PathBuf) -> Self {
        Self { path }
    }

    /// Store in the default screenpipe data directory (honours
    /// `SCREENPIPE_DATA_DIR`, falls back to `~/.screenpipe`).
    pub(super) fn default_location() -> Self {
        Self::in_dir(&screenpipe_core::paths::default_screenpipe_data_dir())
    }

    /// Store inside `dir` using the standard file name.
    pub(super) fn in_dir(dir: &Path) -> Self {
        Self::new(dir.join(RESTORE_TOKEN_FILE_NAME))
    }

    /// Path of the backing file.
    pub(super) fn path(&self) -> &Path {
        &self.path
    }

    /// Returns the persisted token, or `None` when the file is missing,
    /// unreadable, or does not contain a well-formed token.
    pub(super) fn load(&self) -> Option<String> {
        let raw = fs::read_to_string(&self.path).ok()?;
        sanitize_token(&raw)
    }

    /// Persists `token` with owner-only permissions. Malformed tokens are
    /// rejected with `InvalidInput` and leave any existing file untouched.
    pub(super) fn save(&self, token: &str) -> io::Result<()> {
        let token = sanitize_token(token).ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "refusing to persist a malformed screencast restore token",
            )
        })?;
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let tmp = self.path.with_extension("tmp");
        let result = write_private(&tmp, &token).and_then(|()| fs::rename(&tmp, &self.path));
        if result.is_err() {
            let _ = fs::remove_file(&tmp);
        }
        result
    }

    /// Deletes the persisted token. A missing file is not an error.
    pub(super) fn clear(&self) -> io::Result<()> {
        match fs::remove_file(&self.path) {
            Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
            _ => Ok(()),
        }
    }
}

/// Trims surrounding whitespace and returns the token when it is non-empty,
/// at most [`MAX_TOKEN_LEN`] bytes, and free of control characters.
fn sanitize_token(raw: &str) -> Option<String> {
    let token = raw.trim();
    let well_formed =
        !token.is_empty() && token.len() <= MAX_TOKEN_LEN && !token.chars().any(char::is_control);
    well_formed.then(|| token.to_string())
}

/// Creates (or truncates) `path` with mode `0600` and writes `contents`.
fn write_private(path: &Path, contents: &str) -> io::Result<()> {
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create(true)
        .truncate(true)
        .mode(0o600)
        .open(path)?;
    // `mode` only applies on creation; tighten a pre-existing temp file too.
    file.set_permissions(fs::Permissions::from_mode(0o600))?;
    file.write_all(contents.as_bytes())?;
    file.sync_all()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store_in(dir: &tempfile::TempDir) -> RestoreTokenStore {
        RestoreTokenStore::in_dir(dir.path())
    }

    #[test]
    fn missing_file_loads_as_none() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(store_in(&dir).load(), None);
    }

    #[test]
    fn save_then_load_round_trips_the_token() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(&dir);
        store.save("c0ffee00-1234-5678-9abc-def012345678").unwrap();
        assert_eq!(
            store.load().as_deref(),
            Some("c0ffee00-1234-5678-9abc-def012345678")
        );
        assert_eq!(store.path(), dir.path().join(RESTORE_TOKEN_FILE_NAME));
    }

    #[test]
    fn saved_token_is_owner_only_and_leaves_no_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(&dir);
        store.save("token").unwrap();
        let mode = fs::metadata(store.path()).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        assert!(!store.path().with_extension("tmp").exists());
    }

    #[test]
    fn save_replaces_an_existing_token() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(&dir);
        store.save("first").unwrap();
        store.save("second").unwrap();
        assert_eq!(store.load().as_deref(), Some("second"));
    }

    #[test]
    fn save_tightens_a_leftover_world_readable_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(&dir);
        let tmp = store.path().with_extension("tmp");
        fs::write(&tmp, "stale").unwrap();
        fs::set_permissions(&tmp, fs::Permissions::from_mode(0o644)).unwrap();
        store.save("fresh").unwrap();
        let mode = fs::metadata(store.path()).unwrap().permissions().mode();
        assert_eq!(mode & 0o777, 0o600);
        assert_eq!(store.load().as_deref(), Some("fresh"));
    }

    #[test]
    fn save_creates_missing_parent_directories() {
        let dir = tempfile::tempdir().unwrap();
        let store = RestoreTokenStore::in_dir(&dir.path().join("nested/data"));
        store.save("token").unwrap();
        assert_eq!(store.load().as_deref(), Some("token"));
    }

    #[test]
    fn save_rejects_malformed_tokens_without_touching_the_file() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(&dir);
        store.save("good").unwrap();
        for bad in ["", "   ", "has\ncontrol", &"x".repeat(MAX_TOKEN_LEN + 1)] {
            let error = store.save(bad).unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
        }
        assert_eq!(store.load().as_deref(), Some("good"));
    }

    #[test]
    fn save_reports_io_errors_and_cleans_up_the_temp_file() {
        let dir = tempfile::tempdir().unwrap();
        // A directory at the target path makes the final rename fail.
        let store = store_in(&dir);
        fs::create_dir(store.path()).unwrap();
        fs::write(store.path().join("occupant"), "x").unwrap();
        assert!(store.save("token").is_err());
        assert!(!store.path().with_extension("tmp").exists());
    }

    #[test]
    fn save_fails_when_the_parent_cannot_be_created() {
        let dir = tempfile::tempdir().unwrap();
        let blocker = dir.path().join("file");
        fs::write(&blocker, "not a directory").unwrap();
        let store = RestoreTokenStore::in_dir(&blocker.join("sub"));
        assert!(store.save("token").is_err());
    }

    #[test]
    fn save_with_an_empty_path_errors_instead_of_panicking() {
        // `Path::new("")` has no parent; the store must not panic on it.
        let store = RestoreTokenStore::new(PathBuf::new());
        assert!(store.save("token").is_err());
    }

    #[test]
    fn load_trims_whitespace_and_ignores_garbage() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(&dir);
        fs::write(store.path(), "  padded-token\n").unwrap();
        assert_eq!(store.load().as_deref(), Some("padded-token"));
        fs::write(store.path(), "bad\u{7}token").unwrap();
        assert_eq!(store.load(), None);
        fs::write(store.path(), "").unwrap();
        assert_eq!(store.load(), None);
    }

    #[test]
    fn clear_removes_the_token_and_tolerates_absence() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(&dir);
        store.save("token").unwrap();
        store.clear().unwrap();
        assert_eq!(store.load(), None);
        store.clear().unwrap();
    }

    #[test]
    fn clear_reports_errors_other_than_not_found() {
        let dir = tempfile::tempdir().unwrap();
        let store = store_in(&dir);
        fs::create_dir(store.path()).unwrap();
        fs::write(store.path().join("occupant"), "x").unwrap();
        assert!(store.clear().is_err());
    }

    #[test]
    fn default_location_uses_the_screenpipe_data_dir() {
        let expected =
            screenpipe_core::paths::default_screenpipe_data_dir().join(RESTORE_TOKEN_FILE_NAME);
        assert_eq!(RestoreTokenStore::default_location().path(), expected);
    }
}
