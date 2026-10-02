// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
//! Agent renderer subprocess. No Tauri window, recorder, or database is started.
use screenpipe_core::workflow_video::{self, Scene};
use std::path::Path;
use tokio::io::AsyncReadExt;

pub async fn run(project: &Path) -> Result<(), String> {
    use fs2::FileExt;
    // Every project is a sibling under the owned video workspace. One encoder
    // per workspace limits memory/CPU across concurrent chat windows.
    let lock_path = project.parent().ok_or("Invalid video workspace")?.join(".render.lock");
    let lock = std::fs::OpenOptions::new().create(true).truncate(false).write(true).open(lock_path).map_err(|e| e.to_string())?;
    lock.try_lock_exclusive().map_err(|_| "Another video is being created. Wait for it to finish or stop it first.")?;
    let token = std::env::var("SCREENPIPE_API_KEY").map_err(|_| "Sign in to Screenpipe to create a video.")?;
    let gateway = crate::config::screenpipe_ai_gateway_url()?;
    let binary = screenpipe_core::ffmpeg::find_ffmpeg_path().ok_or("Screenpipe's video tools are unavailable.")?;
    let manifest = project.join("render-scenes.json");
    if std::fs::metadata(&manifest).map_err(|e| e.to_string())?.len() > 100_000 { return Err("Video plan is too large".into()); }
    let scenes: Vec<Scene> = serde_json::from_slice(&std::fs::read(manifest).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
    workflow_video::validate(&scenes).map_err(|e| e.to_string())?;
    let project = project.canonicalize().map_err(|e| e.to_string())?;
    let mut bytes = 0;
    for scene in &scenes {
        if let Some(image) = &scene.image {
            let path = image.canonicalize().map_err(|_| "A screenshot is unavailable")?;
            if path.parent() != Some(project.as_path()) { return Err("Screenshot is outside the video project".into()); }
            bytes += std::fs::metadata(path).map_err(|e| e.to_string())?.len();
            if bytes > 80 * 1024 * 1024 { return Err("Video screenshots exceed the export limit".into()); }
        }
    }
    let output = project.join("rendered");
    std::fs::create_dir(&output).map_err(|e| e.to_string())?;
    let (cancel, receiver) = tokio::sync::watch::channel(false);
    // Closing stdin cancels on stop or parent death. main exits the process
    // explicitly, so an idle stdin reader cannot delay successful completion.
    let watcher = tokio::spawn(async move {
        let _ = tokio::io::stdin().read(&mut [0u8; 1]).await;
        let _ = cancel.send(true);
    });
    let result = workflow_video::render(&scenes, &output, &binary, &gateway, &token, receiver, |index, total, phase| {
        println!("{}", serde_json::json!({"progress": format!("{phase} {index} of {total}")}));
    }).await;
    watcher.abort();
    match result {
        Ok(()) => { println!("{}", serde_json::json!({"complete": true})); Ok(()) }
        Err(error) => { let _ = std::fs::remove_dir_all(output); Err(error.to_string()) }
    }
}
