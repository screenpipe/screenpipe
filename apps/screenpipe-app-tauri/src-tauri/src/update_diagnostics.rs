// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Installer evidence survives the dying process and application-log rotation.
//! Only normal, consented support collection sends these locally redacted bytes.

use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::sync::Mutex;

pub(crate) const LOG_NAME: &str = "update-install.log";
const MAX_BYTES: u64 = 32 * 1024;
static WRITER: Mutex<()> = Mutex::new(());

pub(crate) fn append(root: &Path, event: &str, detail: &str) {
    let _guard = WRITER.lock().unwrap_or_else(|error| error.into_inner());
    let result = (|| -> std::io::Result<()> {
        std::fs::create_dir_all(root)?;
        let path = root.join(LOG_NAME);
        if std::fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink()) {
            return Err(std::io::Error::other(
                "updater diagnostic path is a symlink",
            ));
        }
        let mut options = std::fs::OpenOptions::new();
        options.create(true).read(true).write(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        }
        let mut file = options.open(path)?;
        if file.metadata()?.len() > MAX_BYTES {
            file.seek(SeekFrom::End(-(MAX_BYTES as i64 / 2)))?;
            let mut tail = Vec::new();
            file.read_to_end(&mut tail)?;
            let start = tail
                .iter()
                .position(|b| *b == b'\n')
                .map_or(tail.len(), |i| i + 1);
            file.set_len(0)?;
            file.rewind()?;
            file.write_all(&tail[start..])?;
        }
        file.seek(SeekFrom::End(0))?;
        let detail: String = detail.chars().take(4096).collect();
        writeln!(
            file,
            "{} {event}: {}",
            chrono::Utc::now().to_rfc3339(),
            detail.replace(['\r', '\n'], " ")
        )?;
        file.sync_data()
    })();
    if let Err(error) = result {
        log::warn!("could not persist updater diagnostic: {error}");
    }
}

pub(crate) fn record(event: &str, detail: &str) {
    append(crate::config::app_data_dir(), event, detail);
}
