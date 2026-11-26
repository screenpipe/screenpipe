// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

#[cfg(not(target_os = "macos"))]
pub async fn install() -> anyhow::Result<()> {
    anyhow::bail!("The Screenpipe FFmpeg mirror supports macOS. Install FFmpeg and FFprobe from your system package manager.");
}

#[cfg(target_os = "macos")]
pub async fn install() -> anyhow::Result<()> {
    use anyhow::{bail, ensure, Context};
    use std::time::Duration;

    if let Some(path) = screenpipe_core::find_ffmpeg_path() {
        println!(
            "FFmpeg and FFprobe are already available at {}",
            path.display()
        );
        return Ok(());
    }

    let (archive, expected_hash) = match std::env::consts::ARCH {
        "aarch64" => (
            "ffmpeg-8.1.3-macos-arm64.zip",
            "51323dcbade2634bb9448b13a81187ad554775ae8eef5b28d4702299812346ae",
        ),
        "x86_64" => (
            "ffmpeg-8.1.3-macos-x86_64.zip",
            "541252465d94282956e9956b81e53435aa93de320f8d52d40b2599fc4a4ad750",
        ),
        other => bail!("The Screenpipe FFmpeg mirror does not support {other}"),
    };

    let destination = screenpipe_core::ffmpeg::mirrored_ffmpeg_dir()
        .context("Could not find the home directory for the FFmpeg install")?;
    let parent = destination
        .parent()
        .context("Invalid FFmpeg install path")?;
    std::fs::create_dir_all(parent)?;
    // Stage next to the destination so the complete pair appears in one rename.
    let staging = tempfile::tempdir_in(parent)?;
    let zip_path = staging.path().join(archive);
    let client = reqwest::Client::builder()
        .redirect(reqwest::redirect::Policy::none())
        .timeout(Duration::from_secs(180))
        .build()?;
    let url = format!(
        "https://downloads.screenpipe.com/ffmpeg/{}/{archive}",
        screenpipe_core::ffmpeg::FFMPEG_MIRROR_RELEASE
    );
    println!("Downloading Screenpipe FFmpeg and FFprobe...");
    download_verified(&client, &url, &zip_path, expected_hash).await?;

    let unpacked = staging.path().join("verified");
    let status = tokio::process::Command::new("/usr/bin/ditto")
        .args(["-x", "-k"])
        .arg(&zip_path)
        .arg(&unpacked)
        .status()
        .await?;
    ensure!(
        status.success(),
        "Could not extract the verified FFmpeg archive"
    );
    for name in ["ffmpeg", "ffprobe"] {
        let path = unpacked.join(name);
        let status = tokio::process::Command::new("/usr/bin/codesign")
            .args([
                "--verify",
                "--strict",
                "-R=anchor apple generic and certificate leaf[subject.OU] = \"URFF7QHPUR\"",
            ])
            .arg(&path)
            .status()
            .await?;
        ensure!(
            status.success(),
            "{name} failed Screenpipe signature verification"
        );
    }

    match std::fs::rename(&unpacked, &destination) {
        Ok(()) => {}
        Err(_) if destination.join("ffmpeg").is_file() && destination.join("ffprobe").is_file() => {
            // An identical completed setup from another process won the rename.
        }
        Err(error) => return Err(error).context("Could not install the verified FFmpeg pair"),
    }
    println!(
        "FFmpeg and FFprobe are available at {}",
        destination.display()
    );
    Ok(())
}

#[cfg(target_os = "macos")]
pub(super) async fn download_verified(
    client: &reqwest::Client,
    url: &str,
    zip_path: &std::path::Path,
    expected_hash: &str,
) -> anyhow::Result<()> {
    use anyhow::ensure;
    use sha2::{Digest, Sha256};
    use tokio::io::AsyncWriteExt;

    let mut response = client.get(url).send().await?.error_for_status()?;
    ensure!(
        response.status().is_success(),
        "FFmpeg mirror returned a non-success status"
    );
    let mut output = tokio::fs::File::create(zip_path).await?;
    let mut digest = Sha256::new();
    let mut received = 0usize;
    while let Some(chunk) = response.chunk().await? {
        received += chunk.len();
        ensure!(
            received <= 64 * 1024 * 1024,
            "FFmpeg archive exceeds the size limit"
        );
        output.write_all(&chunk).await?;
        digest.update(&chunk);
    }
    output.flush().await?;
    drop(output);
    ensure!(
        format!("{:x}", digest.finalize()) == expected_hash,
        "FFmpeg archive failed SHA-256 verification"
    );
    Ok(())
}
