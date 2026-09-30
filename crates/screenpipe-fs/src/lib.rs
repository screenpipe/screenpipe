// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! File durability shared by capture, SQLite lifecycle, and Parquet publication.
//! No filesystem detection, allocation, or additional syscall on local success.

use std::{fs::File, io};

/// Inspect an existing path before opening SQLite. Network volumes need the
/// macOS VFS's filesystem-specific locks, not unix-excl's POSIX byte locks.
#[cfg(target_os = "macos")]
pub fn is_network_volume(path: &std::path::Path) -> io::Result<bool> {
    use std::os::unix::ffi::OsStrExt;
    let path = std::ffi::CString::new(path.as_os_str().as_bytes())?;
    let mut stat = std::mem::MaybeUninit::<libc::statfs>::uninit();
    // SAFETY: the pathname is NUL-terminated and stat points to writable storage.
    if unsafe { libc::statfs(path.as_ptr(), stat.as_mut_ptr()) } != 0 {
        return Err(io::Error::last_os_error());
    }
    // SAFETY: statfs initialized the structure on success.
    Ok(unsafe { stat.assume_init() }.f_flags & libc::MNT_LOCAL as u32 == 0)
}

/// Flush contents and metadata before publishing a file. Rust uses F_FULLFSYNC
/// on macOS; SMB supports fsync (server FLUSH) but rejects that device-cache
/// operation. Fall back only for ENOTSUP, never for disk, permission, or network
/// failures. A successful server flush still depends on the server's durability
/// contract, just as SQLite's own full_fsync fallback does.
pub fn sync_all(file: &File) -> io::Result<()> {
    let result = file.sync_all();
    #[cfg(target_os = "macos")]
    return supported_sync(result, || {
        use std::os::fd::AsRawFd;
        loop {
            // SAFETY: the borrowed File keeps this descriptor open.
            if unsafe { libc::fsync(file.as_raw_fd()) } == 0 {
                return Ok(());
            }
            let error = io::Error::last_os_error();
            if error.kind() != io::ErrorKind::Interrupted {
                return Err(error);
            }
        }
    });
    #[cfg(not(target_os = "macos"))]
    result
}

#[cfg(target_os = "macos")]
fn supported_sync(
    full_sync: io::Result<()>,
    fsync: impl FnOnce() -> io::Result<()>,
) -> io::Result<()> {
    match full_sync {
        Err(error) if error.raw_os_error() == Some(libc::ENOTSUP) => fsync(),
        result => result,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flushes_written_file() {
        use std::io::Write;
        let mut file = tempfile::tempfile().unwrap();
        file.write_all(b"durable recording").unwrap();
        sync_all(&file).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn unsupported_full_sync_requires_successful_fsync() {
        supported_sync(Err(io::Error::from_raw_os_error(libc::ENOTSUP)), || Ok(())).unwrap();
        let error = supported_sync(Err(io::Error::from_raw_os_error(libc::ENOTSUP)), || {
            Err(io::Error::from_raw_os_error(libc::EIO))
        })
        .unwrap_err();
        assert_eq!(error.raw_os_error(), Some(libc::EIO));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn successful_full_sync_and_real_errors_never_fall_back() {
        supported_sync(Ok(()), || panic!("unnecessary fallback")).unwrap();
        for code in [
            libc::EIO,
            libc::ENOSPC,
            libc::EACCES,
            libc::EBADF,
            libc::ETIMEDOUT,
        ] {
            let error = supported_sync(Err(io::Error::from_raw_os_error(code)), || {
                panic!("must preserve real sync failure")
            })
            .unwrap_err();
            assert_eq!(error.raw_os_error(), Some(code));
        }
    }
}
