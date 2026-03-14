use chrono;
use serde::{Deserialize, Serialize};
use serde_json;
use sha2::{Digest, Sha256};
use std::fs;
use std::io;
use std::path::{Path, PathBuf};
use sysinfo::{DiskExt, System, SystemExt};
use tracing::{info, warn};

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DiskUsage {
    pub media: DiskUsedByMedia,
    pub other: DiskUsedByOther,
    pub total_data_size: String,
    pub total_cache_size: String,
    pub available_space: String,
    /// Oldest file date in data dir (ISO 8601), for "recording since" display.
    pub recording_since: Option<String>,
    /// Raw total data bytes for frontend calculations.
    pub total_data_bytes: u64,
    /// Raw available space bytes for frontend calculations.
    pub available_space_bytes: u64,
    /// Actual cache directory path (from dirs::cache_dir + screenpipe). Platform-specific.
    #[serde(default)]
    pub cache_dir_path: Option<String>,
    /// Mount point of the disk containing this directory. For frontend same-disk detection.
    #[serde(default)]
    pub disk_mount_point: Option<String>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct MonitorUsage {
    pub name: String,
    pub size: String,
    pub size_bytes: u64,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DiskUsedByMedia {
    pub videos_size: String,
    pub audios_size: String,
    pub total_media_size: String,
    pub monitors: Vec<MonitorUsage>,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct DiskUsedByOther {
    pub database_size: String,
    pub logs_size: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct CachedDiskUsage {
    pub timestamp: i64,
    pub usage: DiskUsage,
}

pub fn get_cache_dir() -> Result<Option<PathBuf>, String> {
    let proj_dirs = dirs::cache_dir().ok_or_else(|| "failed to get cache dir".to_string())?;
    Ok(Some(proj_dirs.join("screenpipe")))
}

/// Path-specific cache filename so custom data dirs don't get ~/.screenpipe's cached usage.
/// Fixes #2458: Disk Usage showed wrong data when user had custom data directory —
/// cache was global; querying custom dir returned default dir's cached stats.
fn cache_filename_for_path(screenpipe_dir: &Path) -> String {
    let normalized = screenpipe_dir
        .to_string_lossy()
        .trim_end_matches(['/', '\\'])
        .to_string();
    let hash = Sha256::digest(normalized.as_bytes());
    format!("disk_usage_{:x}.json", hash)
}

pub fn directory_size(path: &Path) -> io::Result<Option<u64>> {
    if !path.exists() {
        return Ok(None);
    }
    let mut size = 0;
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        let metadata = entry.metadata()?;
        if metadata.is_dir() {
            size += directory_size(&entry.path())?.unwrap_or(0);
        } else {
            size += metadata.len();
        }
    }
    Ok(Some(size))
}

pub fn readable(size: u64) -> String {
    if size == 0 {
        return "0 KB".to_string();
    }

    let units = ["B", "KB", "MB", "GB", "TB"];
    let mut size = size as f64;
    let mut unit = 0;

    while size >= 1024.0 && unit < units.len() - 1 {
        size /= 1024.0;
        unit += 1;
    }

    if unit == 0 {
        format!("{:.0} {}", size, units[unit])
    } else if units[unit] == "GB" || units[unit] == "TB" {
        format!("{:.2} {}", size, units[unit])
    } else {
        format!("{:.1} {}", size, units[unit])
    }
}

pub async fn disk_usage(
    screenpipe_dir: &PathBuf,
    force_refresh: bool,
) -> Result<Option<DiskUsage>, String> {
    info!(
        "Calculating disk usage for directory: {} (force_refresh: {})",
        screenpipe_dir.display(),
        force_refresh
    );
    let data_dir = screenpipe_dir.join("data");

    let cache_dir = match get_cache_dir()? {
        Some(dir) => dir,
        None => return Err("Cache directory not found".to_string()),
    };

    fs::create_dir_all(&cache_dir).map_err(|e| e.to_string())?;
    let cache_file = cache_dir.join(cache_filename_for_path(screenpipe_dir));

    // Skip cache if force_refresh is requested
    if !force_refresh {
        if let Ok(content) = fs::read_to_string(&cache_file) {
            if content.contains("---") {
                info!("Cache contains incomplete values, recalculating...");
            } else if let Ok(cached) = serde_json::from_str::<CachedDiskUsage>(&content) {
                let now = chrono::Local::now().timestamp();
                let one_hour = 60 * 60; // 1 hour cache (reduced from 2 days)
                if now - cached.timestamp < one_hour {
                    info!(
                        "Using cached disk usage data (age: {}s)",
                        now - cached.timestamp
                    );
                    return Ok(Some(cached.usage));
                }
            }
        }
    } else {
        info!("Force refresh requested, bypassing cache");
    }

    let mut total_video_size: u64 = 0;
    let mut total_audio_size: u64 = 0;

    // Calculate total data size
    info!(
        "Calculating total data size for: {}",
        screenpipe_dir.display()
    );
    let total_data_size_bytes = directory_size(screenpipe_dir)
        .map_err(|e| e.to_string())?
        .unwrap_or(0);
    let total_data_size = if total_data_size_bytes > 0 {
        info!("Total data size: {} bytes", total_data_size_bytes);
        readable(total_data_size_bytes)
    } else {
        warn!("Could not calculate total data size");
        "---".to_string()
    };

    // Calculate cache size
    info!("Calculating cache size for: {}", cache_dir.display());
    let total_cache_size = match directory_size(&cache_dir).map_err(|e| e.to_string())? {
        Some(size) => {
            info!("Total cache size: {} bytes", size);
            readable(size)
        }
        None => {
            warn!("Could not calculate cache size");
            "---".to_string()
        }
    };

    // Calculate individual media file sizes recursively, tracking per-monitor usage
    let mut monitor_sizes: std::collections::HashMap<String, u64> =
        std::collections::HashMap::new();

    if data_dir.exists() {
        info!("Scanning data directory recursively for media files");
        fn scan_media_files(
            dir: &Path,
            video_size: &mut u64,
            audio_size: &mut u64,
            monitor_sizes: &mut std::collections::HashMap<String, u64>,
        ) -> io::Result<()> {
            // Regex to extract monitor name prefix before the timestamp
            // Matches: "monitor_1_2026-..." or "Display 3 (output)_2026-..."
            let monitor_re =
                regex::Regex::new(r"^(.+?)_\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.\w+$").ok();

            for entry in fs::read_dir(dir)? {
                let entry = entry?;
                let path = entry.path();
                if path.is_dir() {
                    scan_media_files(&path, video_size, audio_size, monitor_sizes)?;
                } else if path.is_file() {
                    let size = entry.metadata()?.len();
                    let file_name = path.file_name().unwrap().to_string_lossy().to_string();

                    let extension = path
                        .extension()
                        .and_then(|ext| ext.to_str())
                        .unwrap_or("")
                        .to_lowercase();

                    if extension == "mp4" {
                        if file_name.contains("(input)")
                            || file_name.contains("(output)")
                            || file_name.to_lowercase().contains("audio")
                            || file_name.to_lowercase().contains("microphone")
                        {
                            *audio_size += size;
                        } else {
                            *video_size += size;
                            // Track per-monitor
                            if let Some(ref re) = monitor_re {
                                if let Some(caps) = re.captures(&file_name) {
                                    let name = caps[1].to_string();
                                    *monitor_sizes.entry(name).or_insert(0) += size;
                                }
                            }
                        }
                    } else {
                        match extension.as_str() {
                            "mp3" | "wav" | "flac" | "aac" | "ogg" | "m4a" | "wma" => {
                                *audio_size += size;
                            }
                            "avi" | "mkv" | "mov" | "wmv" | "flv" | "webm" | "m4v" => {
                                *video_size += size;
                            }
                            _ => {}
                        }
                    }
                }
            }
            Ok(())
        }

        if let Err(e) = scan_media_files(
            &data_dir,
            &mut total_video_size,
            &mut total_audio_size,
            &mut monitor_sizes,
        ) {
            warn!("Error scanning media files: {}", e);
        }

        info!(
            "Video files total: {} bytes, Audio files total: {} bytes, monitors: {:?}",
            total_video_size,
            total_audio_size,
            monitor_sizes.keys().collect::<Vec<_>>()
        );
    } else {
        warn!("Data directory does not exist: {}", data_dir.display());
    }

    let videos_size_str = readable(total_video_size);
    let audios_size_str = readable(total_audio_size);
    let total_media_size_calculated = total_video_size + total_audio_size;
    let total_media_size_str = readable(total_media_size_calculated);

    // Calculate database size (db.sqlite and related files)
    info!("Calculating database size");
    let mut database_size: u64 = 0;
    for file_name in ["db.sqlite", "db.sqlite-wal", "db.sqlite-shm"] {
        let db_path = screenpipe_dir.join(file_name);
        if db_path.exists() {
            if let Ok(metadata) = fs::metadata(&db_path) {
                database_size += metadata.len();
            }
        }
    }
    info!("Database size: {} bytes", database_size);

    // Calculate log files size
    info!("Calculating log files size");
    let mut logs_size: u64 = 0;
    if let Ok(entries) = fs::read_dir(screenpipe_dir) {
        for entry in entries.flatten() {
            let path = entry.path();
            if path.is_file() {
                let file_name = path.file_name().unwrap_or_default().to_string_lossy();
                if file_name.ends_with(".log") {
                    if let Ok(metadata) = entry.metadata() {
                        logs_size += metadata.len();
                    }
                }
            }
        }
    }
    info!("Logs size: {} bytes", logs_size);

    // Calculate available space
    info!("Calculating available disk space");
    let (available_space, disk_mount_point) = {
        let mut sys = System::new();
        sys.refresh_disks_list();
        let path_obj = Path::new(&screenpipe_dir);
        let disk_info = sys.disks().iter().find(|disk| path_obj.starts_with(disk.mount_point()));
        let (available, mount) = match disk_info {
            Some(d) => (
                d.available_space(),
                Some(d.mount_point().to_string_lossy().to_string()),
            ),
            None => (0u64, None),
        };
        info!("Available disk space: {} bytes", available);
        (available, mount)
    };

    // Find oldest recording date by parsing filenames (*_YYYY-MM-DD_HH-MM-SS.mp4)
    // More reliable than filesystem timestamps which can reflect copy/move time.
    let recording_since = if data_dir.exists() {
        let date_re = regex::Regex::new(r"(\d{4}-\d{2}-\d{2})_\d{2}-\d{2}-\d{2}\.\w+$").ok();
        let mut oldest: Option<String> = None;
        if let (Some(re), Ok(entries)) = (&date_re, fs::read_dir(&data_dir)) {
            for entry in entries.flatten() {
                let name = entry.file_name().to_string_lossy().to_string();
                if let Some(caps) = re.captures(&name) {
                    let date = caps[1].to_string();
                    oldest = Some(match oldest {
                        Some(prev) if date < prev => date,
                        Some(prev) => prev,
                        None => date,
                    });
                }
            }
        }
        oldest
    } else {
        None
    };

    let mut monitors: Vec<MonitorUsage> = monitor_sizes
        .into_iter()
        .map(|(name, bytes)| MonitorUsage {
            name,
            size: readable(bytes),
            size_bytes: bytes,
        })
        .collect();
    monitors.sort_by(|a, b| b.size_bytes.cmp(&a.size_bytes));

    let disk_usage = DiskUsage {
        media: DiskUsedByMedia {
            videos_size: videos_size_str,
            audios_size: audios_size_str,
            total_media_size: total_media_size_str,
            monitors,
        },
        other: DiskUsedByOther {
            database_size: readable(database_size),
            logs_size: readable(logs_size),
        },
        total_data_size,
        total_cache_size,
        available_space: readable(available_space),
        recording_since,
        total_data_bytes: total_data_size_bytes,
        available_space_bytes: available_space,
        cache_dir_path: Some(cache_dir.to_string_lossy().to_string()),
        disk_mount_point,
    };

    info!("Disk usage calculation completed: {:?}", disk_usage);

    // Cache the result
    let cached = CachedDiskUsage {
        timestamp: chrono::Local::now().timestamp(),
        usage: disk_usage.clone(),
    };

    info!(
        "Writing disk usage cache file: {}",
        cache_file.to_string_lossy()
    );

    if let Err(e) = fs::write(&cache_file, serde_json::to_string_pretty(&cached).unwrap()) {
        warn!("Failed to write cache file: {}", e);
    }

    Ok(Some(disk_usage))
}
