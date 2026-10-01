// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
use base64::Engine;
use once_cell::sync::Lazy;
use screenpipe_core::workflow_video::{self, Scene};
use std::{collections::HashSet, sync::Mutex};
use tauri::{Emitter, Manager};
use tokio::sync::watch;

static ACTIVE: Lazy<Mutex<Option<(String, watch::Sender<bool>)>>> = Lazy::new(|| Mutex::new(None));
static PREVIEWS: Lazy<Mutex<HashSet<String>>> = Lazy::new(|| Mutex::new(HashSet::new()));

#[derive(serde::Deserialize, specta::Type)]
pub struct WorkflowVideoScene {
    title: String,
    narration: String,
    image: Option<String>,
    #[serde(default = "normal_pace")]
    pace: f64,
    focus: Option<WorkflowVideoFocus>,
}

fn normal_pace() -> f64 {
    1.0
}
#[derive(serde::Deserialize, specta::Type)]
pub struct WorkflowVideoFocus {
    x: f64,
    y: f64,
    zoom: f64,
}

#[derive(serde::Serialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct WorkflowVideoResult {
    path: String,
    captions_path: String,
}

struct ActiveJob;
impl Drop for ActiveJob {
    fn drop(&mut self) {
        *ACTIVE.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
}

#[tauri::command]
#[specta::specta]
pub async fn cancel_workflow_video(id: String) -> Result<(), String> {
    if let Some((active, cancel)) = ACTIVE
        .lock()
        .map_err(|_| "Video state unavailable")?
        .as_ref()
    {
        if *active == id {
            let _ = cancel.send(true);
        }
    }
    Ok(())
}

#[tauri::command]
#[specta::specta]
pub async fn create_workflow_video(
    app: tauri::AppHandle,
    id: String,
    scenes: Vec<WorkflowVideoScene>,
) -> Result<WorkflowVideoResult, String> {
    uuid::Uuid::parse_str(&id).map_err(|_| "Invalid video request")?;
    let (cancel, receiver) = watch::channel(false);
    {
        let mut active = ACTIVE.lock().map_err(|_| "Video state unavailable")?;
        if active.is_some() {
            return Err(
                "Another video is being created. Wait for it to finish or stop it first.".into(),
            );
        }
        *active = Some((id.clone(), cancel));
    }
    let _active = ActiveJob;
    let result = async {
        let token = crate::commands::get_cloud_token().ok_or("Sign in to Screenpipe to create a video.")?;
        let gateway = crate::config::screenpipe_ai_gateway_url()?;
        let binary = screenpipe_core::ffmpeg::find_ffmpeg_path().ok_or("Screenpipe's video tools are unavailable. Restart the app and try again.")?;
        let root = app.path().app_data_dir().map_err(|_| "Could not find local app storage")?.join("workflow-videos");
        std::fs::create_dir_all(&root).map_err(|_| "Could not create local video storage")?;
        // Crash leftovers are owned by this feature. Keep current previews; prune abandoned
        // outputs after a day and bound the cache before spending on speech.
        let mut cached_bytes = 0;
        for entry in std::fs::read_dir(&root).map_err(|_| "Could not read video storage")?.flatten() {
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with(".render-") { let _ = std::fs::remove_dir_all(entry.path()); }
            else if uuid::Uuid::parse_str(&name).is_ok() {
                let abandoned = !PREVIEWS.lock().map_err(|_| "Video state unavailable")?.contains(&name)
                    && entry.metadata().ok().and_then(|m| m.modified().ok()).and_then(|t| t.elapsed().ok()).is_some_and(|age| age.as_secs() > 86400);
                if abandoned { let _ = std::fs::remove_dir_all(entry.path()); }
                cached_bytes += std::fs::metadata(entry.path().join("video.mp4")).map(|m| m.len()).unwrap_or(0);
            }
        }
        if cached_bytes > 700 * 1024 * 1024 { return Err("Video preview storage is full. Download and close other video previews before creating another.".into()); }
        let temporary = tempfile::Builder::new().prefix(".render-").tempdir_in(&root).map_err(|_| "Could not prepare video storage")?;
        let mut input = Vec::new();
        let mut image_bytes = 0;
        if scenes.len() > 50 { return Err("This SOP has too many sections for one video.".to_owned()); }
        for (i, scene) in scenes.into_iter().enumerate() {
            let image = if let Some(data) = scene.image {
                if data.len() > 16 * 1024 * 1024 { return Err("A screenshot is too large for video export.".into()); }
                let (prefix, encoded) = data.split_once(',').ok_or("A screenshot could not be read.")?;
                if !["data:image/png;base64", "data:image/jpeg;base64", "data:image/webp;base64"].contains(&prefix) { return Err("Unsupported screenshot format.".into()); }
                let bytes = base64::engine::general_purpose::STANDARD.decode(encoded).map_err(|_| "A screenshot could not be read.")?;
                image_bytes += bytes.len();
                if image_bytes > 80 * 1024 * 1024 { return Err("The screenshots exceed the video export limit.".into()); }
                let path = temporary.path().join(format!("source-{i}.image"));
                std::fs::write(&path, bytes).map_err(|_| "Could not prepare a screenshot")?;
                Some(path)
            } else { None };
            input.push(Scene { title: scene.title, narration: scene.narration, image, pace: scene.pace, focus: scene.focus.map(|f| workflow_video::Focus { x: f.x, y: f.y, zoom: f.zoom }) });
        }
        let event = format!("workflow-video-{id}");
        // Announce registration before rendering so cancellation cannot race command startup.
        let _ = app.emit(&event, "Preparing video");
        workflow_video::render(&input, temporary.path(), &binary, &gateway, &token, receiver, |index, total, phase| {
            let _ = app.emit(&event, format!("{phase} {index} of {total}"));
        }).await.map_err(|e| e.to_string())?;
        let destination = root.join(&id);
        std::fs::create_dir(&destination).map_err(|_| "Could not save the video")?;
        for file in ["video.mp4", "captions.vtt"] {
            if std::fs::rename(temporary.path().join(file), destination.join(file)).is_err() {
                let _ = std::fs::remove_dir_all(&destination);
                return Err("Could not save the video. Check available disk space.".into());
            }
        }
        PREVIEWS.lock().map_err(|_| "Video state unavailable")?.insert(id);
        Ok(WorkflowVideoResult { path: destination.join("video.mp4").to_string_lossy().into_owned(), captions_path: destination.join("captions.vtt").to_string_lossy().into_owned() })
    }.await;
    result
}

/// Outputs remain available while reviewing. Explicit discard bounds permanent local storage.
#[tauri::command]
#[specta::specta]
pub async fn discard_workflow_video(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let id = uuid::Uuid::parse_str(&id)
        .map_err(|_| "Invalid video")?
        .to_string();
    let root = app
        .path()
        .app_data_dir()
        .map_err(|_| "Could not find video storage")?
        .join("workflow-videos")
        .join(&id);
    if root.exists() {
        std::fs::remove_dir_all(root).map_err(|_| "Could not remove the video")?;
    }
    PREVIEWS
        .lock()
        .map_err(|_| "Video state unavailable")?
        .remove(&id);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workflow_video_unicode_segments_preserve_content_and_limits() {
        for text in [
            "你好😀".repeat(300),
            "word ".repeat(300),
            "a".repeat(801),
            "Before\n\nafter\tdecision".into(),
        ] {
            let parts = workflow_video::segments(&text);
            assert!(parts
                .iter()
                .all(|p| !p.is_empty() && p.chars().count() <= 240));
            assert_eq!(
                parts.concat().split_whitespace().collect::<String>(),
                text.split_whitespace().collect::<String>()
            );
        }
    }

    #[test]
    fn workflow_video_rejects_oversized_and_empty_plans() {
        assert!(workflow_video::validate(&[]).is_err());
        assert!(workflow_video::validate(&[Scene {
            title: "Test".into(),
            narration: "a".repeat(18001),
            image: None,
            pace: 1.0,
            focus: None
        }])
        .is_err());
    }

    #[test]
    fn workflow_video_rejects_invalid_focus_and_pace() {
        let scene = Scene {
            title: "Read".into(),
            narration: "Read the result".into(),
            image: None,
            pace: 1.0,
            focus: None,
        };
        for pace in [f64::NAN, 0.0, 0.84, 1.26] {
            assert!(workflow_video::validate(&[Scene {
                pace,
                ..scene.clone()
            }])
            .is_err());
        }
        assert!(workflow_video::validate(&[Scene {
            focus: Some(workflow_video::Focus {
                x: 0.5,
                y: 0.5,
                zoom: 1.2
            }),
            ..scene
        }])
        .is_err());
    }

    #[tokio::test]
    async fn workflow_video_renderer_success_failure_and_cancel() {
        use wiremock::{
            matchers::{method, path},
            Mock, MockServer, ResponseTemplate,
        };
        let Some(binary) = screenpipe_core::ffmpeg::find_ffmpeg_path() else {
            panic!("Run video tests through test:tauri, which provisions the bundled renderer");
        };
        let server = MockServer::start().await;
        let temporary = tempfile::tempdir().unwrap();
        let scene = Scene {
            title: "Reviewer's [brief]: 100% {checked}".into(),
            narration: "Read the instructions and confirm the result.".into(),
            image: None,
            pace: 1.0,
            focus: None,
        };
        // A tiny WAV fixture checks muxing/timing, not speech quality (covered by live eval).
        let mut wav = Vec::new();
        wav.extend(b"RIFF");
        wav.extend(6436u32.to_le_bytes());
        wav.extend(b"WAVEfmt ");
        wav.extend(16u32.to_le_bytes());
        wav.extend(1u16.to_le_bytes());
        wav.extend(1u16.to_le_bytes());
        wav.extend(16000u32.to_le_bytes());
        wav.extend(32000u32.to_le_bytes());
        wav.extend(2u16.to_le_bytes());
        wav.extend(16u16.to_le_bytes());
        wav.extend(b"data");
        wav.extend(6400u32.to_le_bytes());
        wav.resize(6444, 0);
        Mock::given(method("POST"))
            .and(path("/tts"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("x-screenpipe-narration-profile", "sop-openai-marin-v1")
                    .insert_header("content-type", "audio/wav")
                    .set_body_bytes(wav.clone()),
            )
            .expect(1)
            .mount(&server)
            .await;
        let (_sender, receiver) = watch::channel(false);
        workflow_video::render(
            &[scene.clone()],
            temporary.path(),
            &binary,
            &server.uri(),
            "test",
            receiver,
            |_, _, _| {},
        )
        .await
        .unwrap();
        assert!(
            std::fs::metadata(temporary.path().join("video.mp4"))
                .unwrap()
                .len()
                > 1000
        );
        let captions = std::fs::read_to_string(temporary.path().join("captions.vtt")).unwrap();
        assert!(captions.contains("00:00:00.000 --> 00:00:00.208"));
        assert!(captions.contains(&scene.narration));
        server.verify().await;
        server.reset().await;
        // Only the failed sixth segment may be repeated.
        let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
        let count = calls.clone();
        let audio = wav.clone();
        Mock::given(method("POST"))
            .respond_with(move |_: &wiremock::Request| {
                let index = count.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                if index == 5 { ResponseTemplate::new(502) }
                else { ResponseTemplate::new(200)
                    .insert_header("x-screenpipe-narration-profile", "sop-openai-marin-v1")
                    .insert_header("content-type", "audio/wav").set_body_bytes(audio.clone()) }
            }).expect(8).mount(&server).await;
        let scenes: Vec<_> = (1..=7).map(|n| Scene { narration: format!("Read section {n}."), ..scene.clone() }).collect();
        let (_sender, receiver) = watch::channel(false);
        workflow_video::render(&scenes, temporary.path(), &binary, &server.uri(), "test", receiver, |_, _, _| {}).await.unwrap();
        let requests = server.received_requests().await.unwrap();
        let narrations: Vec<String> = requests.iter().map(|r| r.body_json::<serde_json::Value>().unwrap()["text"].as_str().unwrap().to_owned()).collect();
        assert_eq!(narrations, ["Read section 1.", "Read section 2.", "Read section 3.", "Read section 4.", "Read section 5.", "Read section 6.", "Read section 6.", "Read section 7."]);
        let captions = std::fs::read_to_string(temporary.path().join("captions.vtt")).unwrap();
        assert_eq!(captions.matches("Read section").count(), 7);
        server.verify().await;
        server.reset().await;
        Mock::given(method("POST"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("content-type", "audio/wav")
                    .set_body_bytes(vec![0u8; 44]),
            )
            .expect(1)
            .mount(&server)
            .await;
        let (_sender, receiver) = watch::channel(false);
        let error = workflow_video::render(
            &[scene.clone()],
            temporary.path(),
            &binary,
            &server.uri(),
            "test",
            receiver,
            |_, _, _| {},
        )
        .await
        .unwrap_err();
        assert!(error
            .to_string()
            .contains("narration service needs an update"));
        server.verify().await;
        server.reset().await;

        // Exercise the actual focus filter and pace-adjusted caption clock.
        let screenshot = temporary.path().join("screenshot.png");
        assert!(std::process::Command::new(&binary)
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=s=1920x1080",
                "-frames:v",
                "1",
                "-threads",
                "1",
                "-y",
            ])
            .arg(&screenshot)
            .status()
            .unwrap()
            .success());
        let mut audio = Vec::new();
        audio.extend(b"RIFF");
        audio.extend(128036u32.to_le_bytes());
        audio.extend(b"WAVEfmt ");
        audio.extend(16u32.to_le_bytes());
        audio.extend(1u16.to_le_bytes());
        audio.extend(1u16.to_le_bytes());
        audio.extend(16000u32.to_le_bytes());
        audio.extend(32000u32.to_le_bytes());
        audio.extend(2u16.to_le_bytes());
        audio.extend(16u16.to_le_bytes());
        audio.extend(b"data");
        audio.extend(128000u32.to_le_bytes());
        audio.resize(128044, 0);
        Mock::given(method("POST"))
            .and(wiremock::matchers::body_partial_json(
                serde_json::json!({"profile":"sop"}),
            ))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("x-screenpipe-narration-profile", "sop-openai-marin-v1")
                    .insert_header("content-type", "audio/wav")
                    .set_body_bytes(audio),
            )
            .expect(1)
            .mount(&server)
            .await;
        // Keep the watch sender alive for the duration of render.
        let (_sender, receiver) = watch::channel(false);
        workflow_video::render(
            &[Scene {
                image: Some(screenshot),
                pace: 1.25,
                focus: Some(workflow_video::Focus {
                    x: 0.7,
                    y: 0.4,
                    zoom: 1.5,
                }),
                ..scene.clone()
            }],
            temporary.path(),
            &binary,
            &server.uri(),
            "test",
            receiver,
            |_, _, _| {},
        )
        .await
        .unwrap();
        let captions = std::fs::read_to_string(temporary.path().join("captions.vtt")).unwrap();
        assert!(
            captions.contains("00:00:03."),
            "pace must shorten four seconds of audio: {captions}"
        );
        server.verify().await;
        server.reset().await;

        // Wide glyphs and long tokens previously ran off the right/bottom edges.
        // Decode the real encoded frame and check its safe margins, not filter strings.
        let plain = temporary.path().join("plain.png");
        assert!(std::process::Command::new(&binary)
            .args([
                "-hide_banner",
                "-loglevel",
                "error",
                "-f",
                "lavfi",
                "-i",
                "color=white:s=1280x624",
                "-frames:v",
                "1",
                "-threads",
                "1",
                "-y"
            ])
            .arg(&plain)
            .status()
            .unwrap()
            .success());
        let fixture = std::fs::read(temporary.path().join("speech.mp3")).unwrap();
        Mock::given(method("POST"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("x-screenpipe-narration-profile", "sop-openai-marin-v1")
                    .insert_header("content-type", "audio/wav")
                    .set_body_bytes(fixture),
            )
            .expect(1)
            .mount(&server)
            .await;
        let (_sender, receiver) = watch::channel(false);
        workflow_video::render(
            &[Scene {
                title: "W".repeat(140),
                narration: "W".repeat(240),
                image: Some(plain),
                pace: 1.0,
                focus: None,
            }],
            temporary.path(),
            &binary,
            &server.uri(),
            "test",
            receiver,
            |_, _, _| {},
        )
        .await
        .unwrap();
        let decoded = std::process::Command::new(&binary)
            .args(["-hide_banner", "-loglevel", "error", "-i"])
            .arg(temporary.path().join("video.mp4"))
            .args([
                "-frames:v",
                "1",
                "-f",
                "rawvideo",
                "-pix_fmt",
                "rgb24",
                "pipe:1",
            ])
            .output()
            .unwrap();
        assert!(decoded.status.success());
        assert_eq!(decoded.stdout.len(), 1280 * 720 * 3);
        for y in 0..720 {
            for x in 0..1280 {
                if x < 8 || x >= 1272 || y >= 712 {
                    let pixel = &decoded.stdout[(y * 1280 + x) * 3..][..3];
                    assert!(pixel.iter().all(|v| *v > 220), "text clipped at {x},{y}");
                }
            }
        }
        let info = std::process::Command::new(&binary)
            .args(["-hide_banner", "-i"])
            .arg(temporary.path().join("video.mp4"))
            .output()
            .unwrap();
        let info = String::from_utf8_lossy(&info.stderr);
        assert!(info.lines().any(|line| line.contains("Subtitle:") && line.contains("(default)")),
            "Exported captions must be enabled by default: {info}");
        let subtitles = std::process::Command::new(&binary)
            .args(["-hide_banner", "-loglevel", "error", "-i"])
            .arg(temporary.path().join("video.mp4"))
            .args(["-map", "0:s:0", "-f", "srt", "pipe:1"])
            .output()
            .unwrap();
        assert!(
            subtitles.status.success(),
            "MP4 must retain selectable narration captions"
        );
        assert!(String::from_utf8(subtitles.stdout)
            .unwrap()
            .contains(&"W".repeat(240)));
        server.verify().await;
        server.reset().await;
        Mock::given(method("POST"))
            .respond_with(ResponseTemplate::new(503).set_body_string("private upstream detail"))
            .expect(3)
            .mount(&server)
            .await;
        let (_sender, receiver) = watch::channel(false);
        let error = workflow_video::render(
            &[scene.clone()],
            temporary.path(),
            &binary,
            &server.uri(),
            "test",
            receiver,
            |_, _, _| {},
        )
        .await
        .unwrap_err();
        assert!(error
            .to_string()
            .contains("Speech generation is unavailable"));
        assert!(!error.to_string().contains("private upstream"));
        assert!(error.to_string().contains("HTTP 503"));
        server.verify().await; // Bounded to three attempts.
        server.reset().await;
        // Stop also cancels the backoff, without starting a second request.
        let (sender, receiver) = watch::channel(false);
        Mock::given(method("POST"))
            .respond_with(move |_: &wiremock::Request| {
                let sender = sender.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(std::time::Duration::from_millis(100)).await;
                    let _ = sender.send(true);
                });
                ResponseTemplate::new(503)
            }).expect(1).mount(&server).await;
        let started = std::time::Instant::now();
        let error = workflow_video::render(&[scene.clone()], temporary.path(), &binary, &server.uri(), "test", receiver, |_, _, _| {}).await.unwrap_err();
        assert!(error.to_string().contains("stopped"));
        assert!(started.elapsed() < std::time::Duration::from_secs(2));
        server.verify().await;
        server.reset().await;
        for (body, expected) in [
            (
                r#"{"error":"{\"error\":\"monthly_cost_limit_exceeded\"}"}"#,
                "monthly AI allowance",
            ),
            ("rate limit exceeded", "busy"),
        ] {
            Mock::given(method("POST"))
                .respond_with(ResponseTemplate::new(429).set_body_string(body))
                .expect(1)
                .mount(&server)
                .await;
            let (_sender, receiver) = watch::channel(false);
            let error = workflow_video::render(
                &[scene.clone()],
                temporary.path(),
                &binary,
                &server.uri(),
                "test",
                receiver,
                |_, _, _| {},
            )
            .await
            .unwrap_err();
            assert!(error.to_string().contains(expected));
            server.verify().await;
            server.reset().await;
        }
        let broken = temporary.path().join("broken.png");
        std::fs::write(&broken, "invalid").unwrap();
        let (_sender, receiver) = watch::channel(false);
        assert!(workflow_video::render(
            &[Scene {
                image: Some(broken),
                ..scene.clone()
            }],
            temporary.path(),
            &binary,
            &server.uri(),
            "test",
            receiver,
            |_, _, _| {}
        )
        .await
        .is_err());
        assert!(server.received_requests().await.unwrap().is_empty());
        let (sender, receiver) = watch::channel(false);
        sender.send(true).unwrap();
        assert!(workflow_video::render(
            &[scene.clone()],
            temporary.path(),
            &binary,
            &server.uri(),
            "test",
            receiver,
            |_, _, _| {}
        )
        .await
        .unwrap_err()
        .to_string()
        .contains("stopped"));
        let (sender, receiver) = watch::channel(false);
        let start = std::time::Instant::now();
        let error = workflow_video::render(
            &[scene],
            temporary.path(),
            &binary,
            &server.uri(),
            "test",
            receiver,
            |_, _, phase| {
                if phase == "Narrating" {
                    sender.send(true).unwrap();
                }
            },
        )
        .await
        .unwrap_err();
        assert!(error.to_string().contains("stopped"));
        assert!(start.elapsed().as_secs() < 10);
    }

    #[tokio::test]
    async fn workflow_video_cancel_does_not_stop_another_job() {
        let (sender, receiver) = watch::channel(false);
        *ACTIVE.lock().unwrap() = Some(("owned-job".into(), sender));
        cancel_workflow_video("other-job".into()).await.unwrap();
        assert!(!*receiver.borrow());
        cancel_workflow_video("owned-job".into()).await.unwrap();
        assert!(*receiver.borrow());
        *ACTIVE.lock().unwrap() = None;
    }

    /// Explicit opt-in live speech + real renderer, private input/output paths only.
    /// Run through test:tauri with SCREENPIPE_VIDEO_EVAL_MANIFEST and AUTH_FILE.
    #[tokio::test]
    #[ignore]
    async fn workflow_video_live_eval() {
        let auth: serde_json::Value = serde_json::from_slice(
            &std::fs::read(
                std::env::var("SCREENPIPE_VIDEO_AUTH_FILE").expect("auth file required"),
            )
            .unwrap(),
        )
        .unwrap();
        eval_manifest(
            "https://api.screenpipe.com/v1",
            auth["screenpipe"]["key"].as_str().unwrap(),
            "live",
        )
        .await;
    }

    /// Recorded, synthetic narration for visual/renderer checks without paid provider calls.
    #[tokio::test]
    #[ignore]
    async fn workflow_video_recorded_speech_eval() {
        use wiremock::{matchers::method, Mock, MockServer, ResponseTemplate};
        let audio = std::fs::read(
            std::env::var("SCREENPIPE_VIDEO_SPEECH_FIXTURE").expect("speech fixture required"),
        )
        .unwrap();
        let server = MockServer::start().await;
        Mock::given(method("POST"))
            .respond_with(
                ResponseTemplate::new(200)
                    .insert_header("x-screenpipe-narration-profile", "sop-openai-marin-v1")
                    .insert_header("content-type", "audio/mpeg")
                    .set_body_bytes(audio),
            )
            .mount(&server)
            .await;
        eval_manifest(&server.uri(), "test", "recorded fixture").await;
    }

    /// Replay exact previously generated narration by text, without a provider request.
    #[tokio::test]
    #[ignore]
    async fn workflow_video_replay_eval() {
        use wiremock::{
            matchers::{body_partial_json, method},
            Mock, MockServer, ResponseTemplate,
        };
        let path =
            std::env::var("SCREENPIPE_VIDEO_REPLAY_MANIFEST").expect("replay manifest required");
        let fixtures: Vec<serde_json::Value> =
            serde_json::from_slice(&std::fs::read(path).unwrap()).unwrap();
        let server = MockServer::start().await;
        for fixture in fixtures {
            Mock::given(method("POST"))
                .and(body_partial_json(
                    serde_json::json!({"text": fixture["text"]}),
                ))
                .respond_with(
                    ResponseTemplate::new(200)
                        .insert_header("x-screenpipe-narration-profile", "sop-openai-marin-v1")
                        .insert_header("content-type", "audio/wav")
                        .set_body_bytes(
                            std::fs::read(fixture["audioPath"].as_str().unwrap()).unwrap(),
                        ),
                )
                .mount(&server)
                .await;
        }
        eval_manifest(&server.uri(), "test", "exact recorded narration replay").await;
    }

    async fn eval_manifest(gateway: &str, token: &str, speech: &str) {
        #[derive(serde::Deserialize)]
        struct Case {
            directory: std::path::PathBuf,
            scenes: Vec<Scene>,
        }
        let manifest =
            std::env::var("SCREENPIPE_VIDEO_EVAL_MANIFEST").expect("private manifest required");
        let cases: Vec<Case> = serde_json::from_slice(&std::fs::read(manifest).unwrap()).unwrap();
        assert!(cases.len() <= 12);
        let binary = screenpipe_core::ffmpeg::find_ffmpeg_path().unwrap();
        let mut results = Vec::new();
        for (index, case) in cases.iter().enumerate() {
            std::fs::create_dir_all(&case.directory).unwrap();
            let (_sender, receiver) = watch::channel(false);
            let start = std::time::Instant::now();
            let result = workflow_video::render(
                &case.scenes,
                &case.directory,
                &binary,
                gateway,
                token,
                receiver,
                |part, total, phase| {
                    println!("case {}: {phase} {part}/{total}", index + 1);
                },
            )
            .await;
            results.push(serde_json::json!({"case":index + 1,"passed":result.is_ok(),"speech":speech,"seconds":start.elapsed().as_secs(),"error":result.err().map(|e|e.to_string())}));
            std::fs::write(
                case.directory.join("result.json"),
                serde_json::to_vec_pretty(results.last().unwrap()).unwrap(),
            )
            .unwrap();
        }
        println!("{}", serde_json::to_string_pretty(&results).unwrap());
        assert!(results.iter().all(|r| r["passed"] == true));
    }
}
