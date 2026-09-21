// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Bounded lifecycle evidence kept separately from noisy rolling application
//! logs. Included in the normal support bundle and its on-device redaction.

use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::sync::Mutex;

pub(crate) const LOG_NAME: &str = "recording-recovery.log";
const MAX_BYTES: u64 = 16 * 1024;
static WRITER: Mutex<()> = Mutex::new(());

pub(crate) fn append(root: &Path, event: &str, detail: &str) {
    let _guard = WRITER.lock().unwrap_or_else(|error| error.into_inner());
    let result = (|| -> std::io::Result<()> {
        let path = root.join(LOG_NAME);
        // A caller cannot redirect diagnostic collection through a symlink.
        if std::fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink()) {
            return Ok(());
        }
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .read(true)
            .write(true)
            .truncate(false)
            .open(&path)?;
        if file.metadata()?.len() > MAX_BYTES {
            file.seek(SeekFrom::End(-(MAX_BYTES as i64 / 2)))?;
            let mut tail = Vec::new();
            file.read_to_end(&mut tail)?;
            let start = tail
                .iter()
                .position(|byte| *byte == b'\n')
                .map_or(tail.len(), |i| i + 1);
            file.set_len(0)?;
            file.rewind()?;
            file.write_all(&tail[start..])?;
        }
        file.seek(SeekFrom::End(0))?;
        let detail: String = detail.chars().take(2048).collect();
        writeln!(
            file,
            "{} {event}: {}",
            chrono::Utc::now().to_rfc3339(),
            detail.replace(['\r', '\n'], " ")
        )?;
        file.flush()
    })();
    if let Err(error) = result {
        tracing::warn!(%error, "could not persist recording recovery diagnostic");
    }
}
