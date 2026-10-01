// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
//! Local narrated SOP rendering. Only narration crosses the speech gateway.
//! Callers own the temporary directory and delete it on success, failure or cancellation.
use crate::ffmpeg::ffmpeg_cmd_async;
use anyhow::{bail, Context, Result};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::{fs, io::AsyncWriteExt, process::Command, sync::watch};

#[derive(Clone, serde::Deserialize)]
pub struct Focus {
    pub x: f64,
    pub y: f64,
    pub zoom: f64,
}
fn normal_pace() -> f64 {
    1.0
}
#[derive(Clone, serde::Deserialize)]
pub struct Scene {
    pub title: String,
    pub narration: String,
    pub image: Option<PathBuf>,
    #[serde(default = "normal_pace")]
    pub pace: f64,
    #[serde(default)]
    pub focus: Option<Focus>,
}

pub fn segments(text: &str) -> Vec<String> {
    // Split on word boundaries where possible; Unicode scalars match the gateway limit.
    let mut rest = text.trim();
    let mut result = Vec::new();
    while !rest.is_empty() {
        let end = rest
            .char_indices()
            .nth(240)
            .map(|(i, _)| i)
            .unwrap_or(rest.len());
        let split = if end == rest.len() {
            end
        } else {
            rest[..end]
                .rfind(char::is_whitespace)
                .filter(|i| *i > 0)
                .unwrap_or(end)
        };
        result.push(rest[..split].trim().to_owned());
        rest = rest[split..].trim_start();
    }
    result
}

pub fn validate(scenes: &[Scene]) -> Result<()> {
    if scenes.is_empty() || scenes.len() > 50 {
        bail!("Use between 1 and 50 video sections.");
    }
    if scenes.iter().any(|s| {
        !s.pace.is_finite()
            || !(0.85..=1.25).contains(&s.pace)
            || s.focus.as_ref().is_some_and(|f| {
                ![f.x, f.y, f.zoom].iter().all(|v| v.is_finite())
                    || !(0.0..=1.0).contains(&f.x)
                    || !(0.0..=1.0).contains(&f.y)
                    || !(1.0..=1.6).contains(&f.zoom)
                    || s.image.is_none()
            })
    }) {
        bail!("Invalid video pace or screenshot focus.");
    }
    if scenes.iter().any(|s| {
        s.title.trim().is_empty() || s.title.chars().count() > 140 || s.narration.trim().is_empty()
    }) {
        bail!("Each section needs a title (up to 140 characters) and narration.");
    }
    if scenes
        .iter()
        .map(|s| s.narration.chars().count())
        .sum::<usize>()
        > 18000
        || scenes
            .iter()
            .map(|s| segments(&s.narration).len())
            .sum::<usize>()
            > 100
    {
        bail!("This SOP is too long for one video. Split it into separate SOPs.");
    }
    Ok(())
}

/// Native pixels bound zoom. Titles/captions never move with the screenshot.
fn screenshot_filter(
    focus: Option<&Focus>,
    width: f64,
    height: f64,
    duration: f64,
    first: bool,
    last: bool,
) -> String {
    let normal = "scale=1280:624:force_original_aspect_ratio=decrease,pad=1280:624:(ow-iw)/2:(oh-ih)/2:color=0xf7f7f3";
    let Some(f) = focus else {
        return normal.into();
    };
    let max_zoom = (width / 1280.0).max(height / 624.0).clamp(1.0, 1.6);
    let zoom = f.zoom.min(max_zoom);
    if zoom <= 1.0 || duration < 2.0 {
        return normal.into();
    }
    let fit = (1280.0 / width).min(624.0 / height);
    let x = ((1280.0 - width * fit) / 2.0 + f.x * width * fit) / 1280.0;
    let y = ((624.0 - height * fit) / 2.0 + f.y * height * fit) / 624.0;
    let enter = if first {
        "min(max((on/24-0.8)/0.3,0),1)"
    } else {
        "1"
    };
    let exit = if last {
        format!("min(max(({}-on/24)/0.3,0),1)", duration - 0.5)
    } else {
        "1".into()
    };
    format!("scale=2048:998:force_original_aspect_ratio=decrease,pad=2048:998:(ow-iw)/2:(oh-ih)/2:color=0xf7f7f3,zoompan=z='1+{}*{enter}*{exit}':x='max(0,min(iw-iw/zoom,iw*{x}-iw/zoom/2))':y='max(0,min(ih-ih/zoom,ih*{y}-ih/zoom/2))':d=1:s=1280x624:fps=24", zoom - 1.0)
}

async fn run(mut command: Command) -> Result<Vec<u8>> {
    // No shell, no inherited stdin, bounded operation, kill the child if the job is dropped.
    command.stdin(Stdio::null()).kill_on_drop(true);
    let output = tokio::time::timeout(Duration::from_secs(180), command.output())
        .await
        .context("Video processing timed out.")??;
    if !output.status.success() {
        // Do not expose source text, file paths or provider credentials in UI/telemetry.
        bail!("Video processing failed. Check that Screenpipe's video tools are available.");
    }
    Ok(output.stdout)
}

fn ffmpeg(binary: &Path, directory: &Path) -> Command {
    let mut command = ffmpeg_cmd_async(binary);
    command.current_dir(directory).args([
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-y",
        "-threads",
        "2",
        "-filter_threads",
        "1",
    ]);
    command
}

fn wrapped(text: &str, width: usize) -> String {
    let mut result = String::new();
    let mut column = 0;
    for word in text.split_whitespace() {
        for (i, c) in word.chars().enumerate() {
            if column >= width {
                result.push('\n');
                column = 0;
            }
            if i == 0 && column > 0 {
                if column + word.chars().count() + 1 > width {
                    result.push('\n');
                    column = 0;
                } else {
                    result.push(' ');
                    column += 1;
                }
            }
            result.push(c);
            column += 1;
        }
    }
    result
}

fn timestamp(samples: usize) -> String {
    let ms = samples * 1000 / 16000;
    format!(
        "{:02}:{:02}:{:02}.{:03}",
        ms / 3600000,
        ms / 60000 % 60,
        ms / 1000 % 60,
        ms % 1000
    )
}

async fn speech(
    client: &reqwest::Client,
    gateway: &str,
    token: &str,
    text: &str,
) -> Result<Vec<u8>> {
    // Retry explicit transient HTTP failures, never account limits or ambiguous
    // transport failures that might already have incurred a speech charge.
    let mut attempt = 0;
    let mut response = loop {
        attempt += 1;
        let mut response = client
            .post(format!("{}/tts", gateway.trim_end_matches('/')))
            .bearer_auth(token)
            .json(&serde_json::json!({"text": text, "profile": "sop"}))
            .send()
            .await
            .context("Could not reach speech generation. Try again when connected.")?;
        if response.status().is_success() {
            break response;
        }
        let status = response.status().as_u16();
        let mut body = Vec::new();
        while let Some(chunk) = response.chunk().await? {
            body.extend_from_slice(&chunk[..chunk.len().min(4096 - body.len())]);
            if body.len() == 4096 {
                break;
            }
        }
        tracing::warn!(status, attempt, "SOP speech request failed");
        if attempt < 3 && matches!(status, 500 | 502 | 503 | 504) {
            drop(response);
            tokio::time::sleep(Duration::from_secs(attempt)).await;
            continue;
        }
        bail!(
            "{} (HTTP {status})",
            speech_failure(status, &String::from_utf8_lossy(&body))
        );
    };
    if response
        .headers()
        .get("x-screenpipe-narration-profile")
        .and_then(|h| h.to_str().ok())
        != Some("sop-openai-marin-v1")
    {
        bail!("The SOP narration service needs an update. Your SOP is unchanged. Try again later.");
    }
    if !response
        .headers()
        .get("content-type")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("")
        .starts_with("audio/")
    {
        bail!("Speech generation returned an invalid audio response.");
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response.chunk().await? {
        if bytes.len() + chunk.len() > 4 * 1024 * 1024 {
            bail!("Speech response exceeded its size limit.");
        }
        bytes.extend_from_slice(&chunk);
    }
    if bytes.is_empty() {
        bail!("Speech generation returned empty audio.");
    }
    Ok(bytes)
}

fn speech_failure(status: u16, body: &str) -> &'static str {
    // The gateway sometimes wraps its error JSON in a string. Match only known codes;
    // never display arbitrary upstream messages or infer an account limit from any 429.
    match status {
        429 if body.contains("monthly_cost_limit_exceeded") => "Your monthly AI allowance is used up. Video creation can resume when it resets. Your SOP is unchanged.",
        429 if body.contains("daily_cost_limit_exceeded") => "Your daily AI allowance is used up. Video creation can resume when it resets. Your SOP is unchanged.",
        429 if body.contains("hosted_ai_global_spend_limit") => "Hosted AI is temporarily paused. Your SOP is unchanged.",
        401 => "Sign in to Screenpipe again to create a video.",
        403 if body.contains("requires Business") => "Video narration requires Business access.",
        403 => "Could not authorize video narration. Sign in again and try again.",
        429 => "Speech generation is busy or its usage limit was reached. Try again later.",
        _ => "Speech generation is unavailable. Your SOP is unchanged. Try again later.",
    }
}

/// Writes video.mp4 and captions.vtt only after rendering every section. Progress has no source text.
pub async fn render(
    scenes: &[Scene],
    directory: &Path,
    binary: &Path,
    gateway: &str,
    token: &str,
    mut cancel: watch::Receiver<bool>,
    progress: impl Fn(usize, usize, &str) + Sync,
) -> Result<()> {
    validate(scenes)?;
    if *cancel.borrow() {
        bail!("Video creation stopped.");
    }
    tokio::select! {
        result = tokio::time::timeout(Duration::from_secs(25 * 60), render_inner(scenes, directory, binary, gateway, token, &progress)) =>
            result.context("Video creation timed out. Your SOP is unchanged.")?,
        _ = cancel.changed() => { bail!("Video creation stopped."); }
    }
}

async fn render_inner(
    scenes: &[Scene],
    directory: &Path,
    binary: &Path,
    gateway: &str,
    token: &str,
    progress: &(impl Fn(usize, usize, &str) + Sync),
) -> Result<()> {
    // Exercise the exact filters and codec before any billable request.
    fs::write(directory.join("title.txt"), "Screenpipe").await?;
    fs::write(directory.join("caption.txt"), "Reviewed SOP").await?;
    fs::write(
        directory.join("preflight.vtt"),
        "WEBVTT\n\n00:00:00.000 --> 00:00:00.042\nReviewed SOP\n",
    )
    .await?;
    // Keep the captured screen unobscured. Narration is a default-enabled MP4 subtitle
    // track and a WebVTT sidecar, never a paragraph burned over the user's work.
    let title_filter = "drawtext=textfile=title.txt:expansion=none:fontsize=20:fontcolor=0x171714:x=32:y=12:line_spacing=4";
    let text_filters = format!("{title_filter},drawtext=text='Text walkthrough':fontsize=18:fontcolor=0x77776f:x=48:y=112,drawtext=textfile=caption.txt:expansion=none:fontsize=24:fontcolor=0x171714:x=48:y=(h-text_h)/2:line_spacing=8");
    let mut check = ffmpeg(binary, directory);
    check.args([
        "-f",
        "lavfi",
        "-i",
        "color=c=0xf7f7f3:s=1280x720:r=24",
        "-i",
        "preflight.vtt",
        "-map",
        "0:v:0",
        "-map",
        "1:s:0",
        "-c:s",
        "mov_text",
        "-vf",
        &text_filters,
        "-frames:v",
        "1",
        "-c:v",
        "libx264",
        "-threads",
        "2",
        "preflight.mp4",
    ]);
    run(check).await?;
    // Decode every referenced image up front. A broken screenshot must not quietly disappear.
    for (i, scene) in scenes.iter().enumerate() {
        if let Some(image) = &scene.image {
            let mut check = ffmpeg(binary, directory);
            check
                .args(["-max_pixels", "40000000", "-i"])
                .arg(image)
                .args([
                    "-frames:v",
                    "1",
                    "-vf",
                    "scale=w='min(iw,2048)':h='min(ih,998)':force_original_aspect_ratio=decrease",
                    "-threads",
                    "1",
                ])
                .arg(format!("image-{i}.png"));
            run(check).await?;
        }
    }
    let client = reqwest::Client::builder()
        .user_agent("screenpipe-desktop-video")
        .timeout(Duration::from_secs(70))
        .redirect(reqwest::redirect::Policy::none())
        .build()?;
    let total: usize = scenes.iter().map(|s| segments(&s.narration).len()).sum();
    let mut part = 0;
    let mut sample_offset = 0;
    let mut captions = String::from("WEBVTT\n\n");
    let mut concat = String::new();
    let mut soundtrack = fs::File::create(directory.join("soundtrack.pcm")).await?;
    for (i, scene) in scenes.iter().enumerate() {
        fs::write(directory.join("title.txt"), wrapped(&scene.title, 50)).await?;
        let parts = segments(&scene.narration);
        for (section_part, narration) in parts.iter().enumerate() {
            progress(part + 1, total, "Narrating");
            let audio = speech(&client, gateway, token, narration).await?;
            fs::write(directory.join("speech.mp3"), audio).await?;
            let mut decode = ffmpeg(binary, directory);
            decode.args([
                "-i",
                "speech.mp3",
                "-t",
                "61",
                "-vn",
                "-af",
                &format!("atempo={}", scene.pace),
                "-f",
                "s16le",
                "-ac",
                "1",
                "-ar",
                "16000",
                "pipe:1",
            ]);
            let pcm = run(decode).await?;
            let samples = pcm.len() / 2;
            if !(1600..=960000).contains(&samples) {
                bail!("Narration audio has an unexpected duration.");
            }
            // Align each complete caption with its own decoded audio, not guessed word timings.
            // Pad to an exact video frame to prevent cumulative caption drift at concatenation.
            let frames = (samples as f64 * 24.0 / 16000.0).ceil() as usize;
            let padded_samples = (frames * 16000).div_ceil(24);
            let mut pcm = pcm;
            pcm.resize(padded_samples * 2, 0);
            soundtrack.write_all(&pcm).await?;
            fs::write(directory.join("caption.txt"), wrapped(&narration, 46)).await?;
            let caption = narration
                .replace('&', "&amp;")
                .replace('<', "&lt;")
                .replace('>', "&gt;");
            captions.push_str(&format!(
                "{} --> {}\n{}\n\n",
                timestamp(sample_offset),
                timestamp(sample_offset + padded_samples),
                caption
            ));
            sample_offset += padded_samples;
            if sample_offset > 16000 * 20 * 60 {
                bail!("This SOP exceeds the 20-minute video limit.");
            }
            progress(part + 1, total, "Rendering");
            let mut encode = ffmpeg(binary, directory);
            let image_filter;
            if scene.image.is_some() {
                encode
                    .args(["-loop", "1", "-framerate", "24", "-i"])
                    .arg(format!("image-{i}.png"));
                let header = fs::read(directory.join(format!("image-{i}.png"))).await?;
                if header.len() < 24 {
                    bail!("Screenshot could not be decoded.");
                }
                let width = u32::from_be_bytes(header[16..20].try_into().unwrap()) as f64;
                let height = u32::from_be_bytes(header[20..24].try_into().unwrap()) as f64;
                let picture = screenshot_filter(
                    scene.focus.as_ref(),
                    width,
                    height,
                    frames as f64 / 24.0,
                    section_part == 0,
                    section_part + 1 == parts.len(),
                );
                image_filter = format!("{picture},pad=1280:720:0:96:color=0xf7f7f3,{title_filter}");
            } else {
                encode.args(["-f", "lavfi", "-i", "color=c=0xf7f7f3:s=1280x720:r=24"]);
                image_filter = text_filters.clone();
            }
            encode
                .args([
                    "-vf",
                    &image_filter,
                    "-t",
                    &format!("{:.6}", frames as f64 / 24.0),
                    "-c:v",
                    "libx264",
                    "-threads",
                    "2",
                    "-preset",
                    "veryfast",
                    "-crf",
                    "23",
                    "-pix_fmt",
                    "yuv420p",
                    "-an",
                    "-movflags",
                    "+faststart",
                ])
                .arg(format!("part-{part}.mp4"));
            run(encode).await?;
            concat.push_str(&format!("file 'part-{part}.mp4'\n"));
            part += 1;
        }
    }
    progress(total, total, "Finishing");
    soundtrack.flush().await?;
    drop(soundtrack);
    fs::write(directory.join("parts.txt"), concat).await?;
    fs::write(directory.join("captions.vtt"), captions).await?;
    let mut join = ffmpeg(binary, directory);
    // Encode audio once, avoiding AAC priming gaps between sections.
    join.args([
        "-f",
        "concat",
        "-safe",
        "1",
        "-i",
        "parts.txt",
        "-f",
        "s16le",
        "-ar",
        "16000",
        "-ac",
        "1",
        "-i",
        "soundtrack.pcm",
        "-i",
        "captions.vtt",
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-map",
        "2:s:0",
        "-c:s",
        "mov_text",
        "-disposition:s:0",
        "default",
        "-metadata:s:s:0",
        "title=Narration",
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-ar",
        "48000",
        "-b:a",
        "96k",
        "-shortest",
        "-movflags",
        "+faststart",
        "video.mp4",
    ]);
    run(join).await?;
    let mut verify = ffmpeg(binary, directory);
    verify.args(["-xerror", "-i", "video.mp4", "-f", "null", "-"]);
    run(verify).await?;
    if fs::metadata(directory.join("video.mp4")).await?.len() > 300 * 1024 * 1024 {
        bail!("The generated video exceeds the file size limit.");
    }
    Ok(())
}
