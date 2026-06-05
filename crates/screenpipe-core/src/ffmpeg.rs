use ffmpeg_sidecar::{
    command::ffmpeg_is_installed,
    download::{check_latest_version, download_ffmpeg_package, ffmpeg_download_url, unpack_ffmpeg},
    paths::sidecar_dir,
    version::ffmpeg_version,
};
use log::{debug, error, info};
use once_cell::sync::Lazy;
use std::path::PathBuf;
use which::which;

#[cfg(not(windows))]
const EXECUTABLE_NAME: &str = "ffmpeg";

#[cfg(windows)]
const EXECUTABLE_NAME: &str = "ffmpeg.exe";

static FFMPEG_PATH: Lazy<Option<PathBuf>> = Lazy::new(find_ffmpeg_path_internal);

pub fn find_ffmpeg_path() -> Option<PathBuf> {
    FFMPEG_PATH.as_ref().map(|p| p.clone())
}

/// Create a `std::process::Command` for ffmpeg with `CREATE_NO_WINDOW` on Windows.
pub fn ffmpeg_cmd(path: impl AsRef<std::ffi::OsStr>) -> std::process::Command {
    #[cfg(not(windows))]
    {
        std::process::Command::new(path)
    }

    #[cfg(windows)]
    {
        let mut cmd = std::process::Command::new(path);
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        cmd
    }
}

/// Create a `tokio::process::Command` for ffmpeg with `CREATE_NO_WINDOW` on Windows.
pub fn ffmpeg_cmd_async(path: impl AsRef<std::ffi::OsStr>) -> tokio::process::Command {
    #[cfg(not(windows))]
    {
        tokio::process::Command::new(path)
    }

    #[cfg(windows)]
    {
        let mut cmd = tokio::process::Command::new(path);
        cmd.creation_flags(0x08000000); // CREATE_NO_WINDOW
        cmd
    }
}

/// True when a usable ffprobe exists next to the given ffmpeg binary, OR
/// somewhere on PATH. Frame extraction requires both — if we return an
/// ffmpeg path without a matching ffprobe we get runtime 500s from
/// `get_ffprobe_path`. Callers should fall through to the next discovery
/// source when this returns false.
fn has_matching_ffprobe(ffmpeg_path: &std::path::Path) -> bool {
    #[cfg(windows)]
    let sibling_names = ["ffprobe.exe", "ffprobe"];
    #[cfg(not(windows))]
    let sibling_names = ["ffprobe"];

    for name in sibling_names {
        if ffmpeg_path.with_file_name(name).exists() {
            return true;
        }
    }

    #[cfg(not(windows))]
    let probe_name = "ffprobe";
    #[cfg(windows)]
    let probe_name = "ffprobe.exe";
    which(probe_name).is_ok()
}

fn find_ffmpeg_path_internal() -> Option<PathBuf> {
    debug!("Starting search for ffmpeg executable");

    // macOS: prefer the app-bundled ffmpeg (Tauri sidecar lands in
    // Contents/MacOS/ffmpeg, sometimes Contents/Resources/ffmpeg) before any
    // system binary. A stale brew install (`/opt/homebrew/bin/ffmpeg` symlinked
    // into a Cellar directory that `brew cleanup` already removed) makes dyld
    // fail with "Library not loaded: …/Cellar/ffmpeg/8.x_y/lib/libavdevice.62.dylib"
    // — we'd otherwise pick that broken binary over our own working bundle.
    #[cfg(target_os = "macos")]
    {
        if let Ok(exe_path) = std::env::current_exe() {
            if let Some(exe_folder) = exe_path.parent() {
                let bundled = exe_folder.join(EXECUTABLE_NAME);
                if bundled.exists() {
                    debug!("Found bundled ffmpeg next to executable: {:?}", bundled);
                    return Some(bundled);
                }
                let in_resources = exe_folder.join("../Resources").join(EXECUTABLE_NAME);
                if in_resources.exists() {
                    debug!("Found bundled ffmpeg in Resources: {:?}", in_resources);
                    return Some(in_resources);
                }
            }
        }
    }

    // Check in the same folder as the executable (only on Linux)
    #[cfg(target_os = "linux")]
    {
        if let Ok(exe_path) = std::env::current_exe() {
            if let Some(exe_folder) = exe_path.parent() {
                debug!("Executable folder: {:?}", exe_folder);
                let ffmpeg_in_exe_folder = exe_folder.join(EXECUTABLE_NAME);
                if ffmpeg_in_exe_folder.exists() {
                    debug!(
                        "Found ffmpeg in executable folder: {:?}",
                        ffmpeg_in_exe_folder
                    );
                    return Some(ffmpeg_in_exe_folder);
                }
                debug!("ffmpeg not found in executable folder");

                let lib_folder = exe_folder.join("lib");
                debug!("Lib folder: {:?}", lib_folder);
                let ffmpeg_in_lib = lib_folder.join(EXECUTABLE_NAME);
                if ffmpeg_in_lib.exists() {
                    debug!("Found ffmpeg in lib folder: {:?}", ffmpeg_in_lib);
                    return Some(ffmpeg_in_lib);
                }
                debug!("ffmpeg not found in lib folder");
            }
        }
    }

    // Check if `ffmpeg` is in the PATH environment variable.
    //
    // We MUST only accept a PATH ffmpeg if a matching ffprobe is available —
    // frame extraction requires both. A user can easily end up with just
    // ffmpeg in ~/.local/bin (e.g. an old auto-install that only extracted
    // ffmpeg, or a user-installed ffmpeg without the full suite); without
    // this guard we pick the broken half-install over the app-bundled pair
    // and every compacted-frame fetch returns a 500. See #2999.
    if let Ok(path) = which(EXECUTABLE_NAME) {
        if has_matching_ffprobe(&path) {
            debug!("Found ffmpeg+ffprobe pair via PATH: {:?}", path);
            return Some(path);
        }
        debug!(
            "ffmpeg in PATH at {:?} has no matching ffprobe — falling through",
            path
        );
    }
    debug!("ffmpeg not found in PATH");

    // Check in $HOME/.local/bin on macOS. Same pair requirement as above.
    #[cfg(target_os = "macos")]
    {
        if let Ok(home) = std::env::var("HOME") {
            let local_bin = PathBuf::from(home).join(".local").join("bin");
            debug!("Checking $HOME/.local/bin: {:?}", local_bin);
            let ffmpeg_in_local_bin = local_bin.join(EXECUTABLE_NAME);
            if ffmpeg_in_local_bin.exists() {
                if has_matching_ffprobe(&ffmpeg_in_local_bin) {
                    debug!(
                        "Found ffmpeg+ffprobe pair in $HOME/.local/bin: {:?}",
                        ffmpeg_in_local_bin
                    );
                    return Some(ffmpeg_in_local_bin);
                }
                debug!(
                    "ffmpeg in ~/.local/bin at {:?} has no matching ffprobe — falling through",
                    ffmpeg_in_local_bin
                );
            }
            debug!("ffmpeg not found in $HOME/.local/bin");
        }
    }

    // Check in current working directory
    if let Ok(cwd) = std::env::current_dir() {
        debug!("Current working directory: {:?}", cwd);
        let ffmpeg_in_cwd = cwd.join(EXECUTABLE_NAME);
        if ffmpeg_in_cwd.is_file() && ffmpeg_in_cwd.exists() {
            debug!(
                "Found ffmpeg in current working directory: {:?}",
                ffmpeg_in_cwd
            );
            return Some(ffmpeg_in_cwd);
        }
        debug!("ffmpeg not found in current working directory");
    }

    // Check in the same folder as the executable (non-Linux platforms)
    #[cfg(not(target_os = "linux"))]
    {
        if let Ok(exe_path) = std::env::current_exe() {
            if let Some(exe_folder) = exe_path.parent() {
                debug!("Executable folder: {:?}", exe_folder);
                let ffmpeg_in_exe_folder = exe_folder.join(EXECUTABLE_NAME);
                if ffmpeg_in_exe_folder.exists() {
                    debug!(
                        "Found ffmpeg in executable folder: {:?}",
                        ffmpeg_in_exe_folder
                    );
                    return Some(ffmpeg_in_exe_folder);
                }
                debug!("ffmpeg not found in executable folder");

                // Platform-specific checks
                #[cfg(target_os = "macos")]
                {
                    let resources_folder = exe_folder.join("../Resources");
                    debug!("Resources folder: {:?}", resources_folder);
                    let ffmpeg_in_resources = resources_folder.join(EXECUTABLE_NAME);
                    if ffmpeg_in_resources.exists() {
                        debug!(
                            "Found ffmpeg in Resources folder: {:?}",
                            ffmpeg_in_resources
                        );
                        return Some(ffmpeg_in_resources);
                    }
                    debug!("ffmpeg not found in Resources folder");
                }
            }
        }
    }

    debug!("ffmpeg not found. installing...");

    if let Err(error) = handle_ffmpeg_installation() {
        error!("failed to install ffmpeg: {}", error);
        return None;
    }

    if let Ok(path) = which(EXECUTABLE_NAME) {
        debug!("found ffmpeg after installation: {:?}", path);
        return Some(path);
    }

    let installation_dir = sidecar_dir().map_err(|e| e.to_string()).unwrap();
    let ffmpeg_in_installation = installation_dir.join(EXECUTABLE_NAME);
    if ffmpeg_in_installation.is_file() {
        debug!("found ffmpeg in directory: {:?}", ffmpeg_in_installation);
        return Some(ffmpeg_in_installation);
    }

    error!("ffmpeg not found even after installation");
    None // Return None if ffmpeg is not found
}

fn handle_ffmpeg_installation() -> Result<(), anyhow::Error> {
    if ffmpeg_is_installed() {
        debug!("ffmpeg is already installed");
        return Ok(());
    }

    info!("ffmpeg not found. installing...");
    match check_latest_version() {
        Ok(version) => debug!("latest version: {}", version),
        Err(e) => debug!("skipping version check due to error: {e}"),
    }

    let download_url = ffmpeg_download_url()?;
    let destination = get_ffmpeg_install_dir()?;

    info!("downloading from: {:?}", download_url);
    let archive_path = download_ffmpeg_package(download_url, &destination)?;
    debug!("downloaded package: {:?}", archive_path);

    debug!("extracting...");
    unpack_ffmpeg(&archive_path, &destination)?;

    let version = ffmpeg_version()?;

    info!("done! installed ffmpeg version {}", version);
    Ok(())
}

#[cfg(target_os = "macos")]
fn get_ffmpeg_install_dir() -> Result<PathBuf, anyhow::Error> {
    let home = dirs::home_dir().ok_or_else(|| anyhow::anyhow!("couldn't find home directory"))?;
    let local_bin = home.join(".local").join("bin");

    // Create directory if it doesn't exist
    if !local_bin.exists() {
        debug!("creating .local/bin directory");
        std::fs::create_dir_all(&local_bin)?;
    }

    // Set directory permissions to 755 (rwxr-xr-x) regardless if it existed or not
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&local_bin, std::fs::Permissions::from_mode(0o755))?;
    }

    // Check both .bashrc and .zshrc
    let shell_configs = vec![
        home.join(".bashrc"),
        home.join(".bash_profile"), // macOS often uses .bash_profile instead of .bashrc
        home.join(".zshrc"),
    ];

    for config in shell_configs {
        if config.exists() {
            let content = std::fs::read_to_string(&config)?;
            if !content.contains(".local/bin") {
                debug!("adding .local/bin to PATH in {:?}", config);
                std::fs::write(
                    config,
                    format!("{}\nexport PATH=\"$HOME/.local/bin:$PATH\"\n", content),
                )?;
            }
        }
    }

    // Ensure the directory is writable
    let metadata = std::fs::metadata(&local_bin)?;
    if !metadata.permissions().readonly() {
        Ok(local_bin)
    } else {
        Err(anyhow::anyhow!(
            "Directory {} is not writable. Please check permissions",
            local_bin.display()
        ))
    }
}

// For other platforms, keep your existing installation directory logic
#[cfg(not(target_os = "macos"))]
fn get_ffmpeg_install_dir() -> Result<PathBuf, anyhow::Error> {
    // Your existing logic for other platforms
    sidecar_dir().map_err(|e| anyhow::anyhow!(e))
}
