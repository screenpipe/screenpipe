use dirs::home_dir;
use serde_json::json;
use sqlx::Row;
use std::path::PathBuf;
use tokio::net::TcpStream;

pub async fn handle_status_command(
    json: bool,
    data_dir: &Option<String>,
    port: u16,
) -> anyhow::Result<()> {
    let base_dir = get_base_dir(data_dir)?;
    let db_path = base_dir.join("data").join("db.sqlite");

    // Check if server is running
    let running = TcpStream::connect(format!("127.0.0.1:{}", port))
        .await
        .is_ok();

    // Get DB stats
    let (frame_count, audio_count, last_timestamp) = if db_path.exists() {
        match screenpipe_db::DatabaseManager::new(&db_path.to_string_lossy()).await {
            Ok(db) => {
                let frames: i64 = sqlx::query("SELECT COUNT(*) as cnt FROM frames")
                    .fetch_one(&db.pool)
                    .await
                    .map(|row| row.get::<i64, _>("cnt"))
                    .unwrap_or(0);

                let audio: i64 = sqlx::query("SELECT COUNT(*) as cnt FROM audio_transcriptions")
                    .fetch_one(&db.pool)
                    .await
                    .map(|row| row.get::<i64, _>("cnt"))
                    .unwrap_or(0);

                let last: String =
                    sqlx::query("SELECT timestamp FROM frames ORDER BY timestamp DESC LIMIT 1")
                        .fetch_optional(&db.pool)
                        .await
                        .ok()
                        .flatten()
                        .map(|row| row.get::<String, _>("timestamp"))
                        .unwrap_or_else(|| "never".to_string());

                (frames, audio, last)
            }
            Err(_) => (0, 0, "error reading db".to_string()),
        }
    } else {
        (0, 0, "no data".to_string())
    };

    // Get data dir size
    let data_size = dir_size(&base_dir.join("data")).unwrap_or(0);
    let data_size_human = format_bytes(data_size);

    if json {
        println!(
            "{}",
            serde_json::to_string_pretty(&json!({
                "running": running,
                "port": port,
                "frames": frame_count,
                "audio_transcriptions": audio_count,
                "last_capture": last_timestamp,
                "data_size_bytes": data_size,
                "data_size": data_size_human,
                "data_dir": base_dir.to_string_lossy(),
            }))?
        );
    } else {
        let status = if running { "running" } else { "not running" };
        let status_icon = if running { "●" } else { "○" };
        println!("screenpipe: {} {} (port {})", status_icon, status, port);
        println!("frames:       {}", frame_count);
        println!("audio:        {}", audio_count);
        println!("last capture: {}", last_timestamp);
        println!("data size:    {}", data_size_human);
        println!("data dir:     {}", base_dir.display());
    }

    Ok(())
}

fn get_base_dir(custom_path: &Option<String>) -> anyhow::Result<PathBuf> {
    let default_path = home_dir()
        .ok_or_else(|| anyhow::anyhow!("failed to get home directory"))?
        .join(".screenpipe");

    Ok(custom_path
        .as_ref()
        .map(PathBuf::from)
        .unwrap_or(default_path))
}

fn dir_size(path: &PathBuf) -> std::io::Result<u64> {
    let mut size = 0;
    if path.is_dir() {
        for entry in std::fs::read_dir(path)? {
            let entry = entry?;
            let metadata = entry.metadata()?;
            if metadata.is_dir() {
                size += dir_size(&entry.path())?;
            } else {
                size += metadata.len();
            }
        }
    }
    Ok(size)
}

fn format_bytes(bytes: u64) -> String {
    const KB: u64 = 1024;
    const MB: u64 = KB * 1024;
    const GB: u64 = MB * 1024;

    if bytes >= GB {
        format!("{:.1} GB", bytes as f64 / GB as f64)
    } else if bytes >= MB {
        format!("{:.1} MB", bytes as f64 / MB as f64)
    } else if bytes >= KB {
        format!("{:.1} KB", bytes as f64 / KB as f64)
    } else {
        format!("{} B", bytes)
    }
}
