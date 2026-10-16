// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
//! Native AEC runs in a child of the same signed executable. CoreAudio calls
//! cannot be cancelled by Tokio; process ownership lets teardown kill and reap
//! a wedged unit before recovery starts another native-AEC capture session.
use super::device::{parse_audio_device, AudioDevice};
use super::stream::{AudioStreamConfig, StreamControl};
use anyhow::{anyhow, bail, Context, Result};
use cpal::traits::{DeviceTrait, StreamTrait};
use std::io::{BufRead, BufReader, BufWriter, Read, Write};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};
use tokio::sync::{broadcast, oneshot};

const MODE: &str = "--screenpipe-native-aec-worker";
const MAGIC: &str = "SPVPIO1";
const START_TIMEOUT: Duration = Duration::from_secs(18);
const SAMPLE_TIMEOUT: Duration = Duration::from_secs(8);
const STOP_GRACE: Duration = Duration::from_millis(500);
const MAX_SAMPLES: usize = 65_536;

enum Packet {
    Ready(AudioStreamConfig),
    Audio(Vec<f32>),
}

/// Drop is the cancellation backstop, including startup errors and panics.
/// Never detach an owned child or leave a native capture worker behind.
struct OwnedChild(Child);
impl Drop for OwnedChild {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn command(device: &AudioDevice) -> Result<Command> {
    let mut command = Command::new(std::env::current_exe()?);
    #[cfg(not(test))]
    command.arg(MODE).arg(device.to_string());
    #[cfg(test)]
    command
        .args([
            "--exact",
            "core::vpio_process::tests::child_entry",
            "--ignored",
            "--nocapture",
        ])
        .env("SCREENPIPE_TEST_AEC_DEVICE", device.to_string());
    Ok(command)
}

pub(super) async fn start(
    device: Arc<AudioDevice>,
    tx: broadcast::Sender<Vec<f32>>,
    control: mpsc::Receiver<StreamControl>,
    capture_failed: Arc<AtomicBool>,
) -> Result<(AudioStreamConfig, tokio::task::JoinHandle<()>)> {
    let command = command(&device)?;
    start_command(command, tx, control, capture_failed, START_TIMEOUT).await
}

async fn start_command(
    command: Command,
    tx: broadcast::Sender<Vec<f32>>,
    control: mpsc::Receiver<StreamControl>,
    capture_failed: Arc<AtomicBool>,
    startup_timeout: Duration,
) -> Result<(AudioStreamConfig, tokio::task::JoinHandle<()>)> {
    let (ready_tx, ready_rx) = oneshot::channel();
    let worker = tokio::task::spawn_blocking(move || {
        let wake_recorder = tx.clone();
        if let Err(error) = supervise(command, tx, control, ready_tx, startup_timeout) {
            tracing::warn!(%error, "native AEC capture worker stopped");
            capture_failed.store(true, Ordering::Release);
            // Wake the recorder after all preceding audio packets. It must
            // persist its tail before exposing disconnection to the monitor.
            let _ = wake_recorder.send(Vec::new());
        }
    });
    match ready_rx.await {
        Ok(Ok(config)) => Ok((config, worker)),
        result => {
            // Supervisor has already killed/reaped before reporting failure.
            worker.await?;
            Err(match result {
                Ok(Err(error)) => error,
                Err(_) => anyhow!("native AEC worker exited before startup"),
                _ => unreachable!(),
            })
        }
    }
}

fn supervise(
    mut command: Command,
    tx: broadcast::Sender<Vec<f32>>,
    control: mpsc::Receiver<StreamControl>,
    ready: oneshot::Sender<Result<AudioStreamConfig>>,
    startup_timeout: Duration,
) -> Result<()> {
    let mut ready = Some(ready);
    let child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn();
    let mut child = match child {
        Ok(child) => OwnedChild(child),
        Err(error) => {
            let _ = ready.take().unwrap().send(Err(error.into()));
            return Ok(());
        }
    };
    let stdout = child.0.stdout.take().context("native AEC stdout missing")?;
    let (packets_tx, packets_rx) = mpsc::sync_channel(8);
    let reader = std::thread::spawn(move || {
        let result = read_packets(stdout, &packets_tx);
        if let Err(error) = result {
            let _ = packets_tx.send(Err(error));
        }
    });
    let mut deadline = Instant::now() + startup_timeout;
    let mut stop_response = None;
    let result = loop {
        match control.try_recv() {
            Ok(StreamControl::Stop { _response, .. }) => {
                stop_response = Some(_response);
                break Ok(());
            }
            Err(mpsc::TryRecvError::Disconnected) => break Ok(()),
            Err(mpsc::TryRecvError::Empty) => {}
        }
        if ready.as_ref().is_some_and(|ready| ready.is_closed()) {
            break Ok(()); // cancelled startup, no orphan
        }
        if Instant::now() >= deadline {
            break Err(anyhow!(
                "native AEC worker stopped delivering microphone samples"
            ));
        }
        match packets_rx.recv_timeout(Duration::from_millis(20)) {
            Ok(Ok(Packet::Ready(config))) => {
                if let Some(ready) = ready.take() {
                    let _ = ready.send(Ok(config));
                    deadline = Instant::now() + SAMPLE_TIMEOUT;
                } else {
                    break Err(anyhow!("duplicate native AEC header"));
                }
            }
            Ok(Ok(Packet::Audio(samples))) => {
                deadline = Instant::now() + SAMPLE_TIMEOUT;
                let _ = tx.send(samples);
            }
            Ok(Err(error)) => break Err(error),
            Err(mpsc::RecvTimeoutError::Disconnected) => {
                break Err(anyhow!("native AEC worker closed audio pipe"))
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {}
        }
    };
    // Ask for graceful native disposal first; a stalled native call cannot
    // hold the parent hostage. Keep stdin open until after kill/wait, so the
    // parent's own teardown path is what establishes completion.
    if let Some(stdin) = child.0.stdin.as_mut() {
        let _ = stdin.write_all(b"s");
    }
    let stop_deadline = Instant::now() + STOP_GRACE;
    while Instant::now() < stop_deadline {
        if child.0.try_wait().ok().flatten().is_some() {
            break;
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    drop(child); // kill if necessary, wait, then close pipe handles
    drop(packets_rx); // release a reader blocked on the bounded queue
    let _ = reader.join();
    if let Some(ready) = ready {
        let message = result
            .as_ref()
            .err()
            .map(ToString::to_string)
            .unwrap_or_else(|| "native AEC startup cancelled".into());
        let _ = ready.send(Err(anyhow!(message)));
    }
    if let Some(response) = stop_response {
        let _ = response.send(());
    }
    result
}

fn read_packets(read: impl Read, packets: &mpsc::SyncSender<Result<Packet>>) -> Result<()> {
    let mut read = BufReader::new(read);
    let mut header = String::new();
    // The test executable emits a small harness preamble. Production emits
    // the header first. Bound parsing so a wrong executable cannot exhaust RAM.
    loop {
        let mut line = String::new();
        let size = read.by_ref().take(256).read_line(&mut line)?;
        if size == 0 {
            bail!("native AEC worker exited before header");
        }
        header.push_str(&line);
        if header.len() > 1024 {
            bail!("invalid native AEC header");
        }
        if line.starts_with(MAGIC) {
            let fields: Vec<_> = line.split_whitespace().collect();
            if fields.len() != 2 {
                bail!("invalid native AEC format");
            }
            let rate: u32 = fields[1].parse()?;
            if !(8_000..=384_000).contains(&rate) {
                bail!("invalid native AEC sample rate");
            }
            packets.send(Ok(Packet::Ready(AudioStreamConfig::new(rate, 1))))?;
            break;
        }
    }
    loop {
        let mut length = [0u8; 4];
        read.read_exact(&mut length)?;
        let count = u32::from_le_bytes(length) as usize;
        if count == 0 || count > MAX_SAMPLES {
            bail!("invalid native AEC packet size");
        }
        let mut bytes = vec![0; count * 4];
        read.read_exact(&mut bytes)?;
        let samples: Vec<f32> = bytes
            .chunks_exact(4)
            .map(|bytes| f32::from_le_bytes(bytes.try_into().unwrap()))
            .collect();
        if !samples.iter().all(|sample| sample.is_finite()) {
            bail!("invalid native AEC sample");
        }
        packets.send(Ok(Packet::Audio(samples)))?;
    }
}

/// Must run before desktop/engine initialization. The helper opens no database,
/// server, UI, or transcription engine and uses the same executable identity.
pub async fn run_hidden_mode() -> Option<i32> {
    let args: Vec<_> = std::env::args().collect();
    if args.get(1).map(String::as_str) != Some(MODE) {
        return None;
    }
    Some(match args.get(2).filter(|_| args.len() == 3) {
        Some(device) => match capture(device).await {
            Ok(()) => 0,
            Err(error) => {
                eprintln!("native AEC worker: {error:#}");
                1
            }
        },
        None => 2,
    })
}

async fn capture(device_name: &str) -> Result<()> {
    let stopping = Arc::new(AtomicBool::new(false));
    let stop = stopping.clone();
    std::thread::spawn(move || {
        let mut byte = [0];
        loop {
            match std::io::stdin().read(&mut byte) {
                // Do not run atexit/native destructors: those may be the very
                // locks that wedged capture. The OS releases process resources.
                Ok(0) | Err(_) => unsafe { libc::_exit(0) },
                Ok(_) => stop.store(true, Ordering::Relaxed),
            }
        }
    });
    let device = parse_audio_device(device_name)?;
    let (native_device, _) = super::device::get_cpal_device_and_config(&device).await?;
    let config = native_device.default_input_config()?;
    let (tx, mut rx) = broadcast::channel(1000);
    let failed = Arc::new(AtomicBool::new(false));
    let failure = failed.clone();
    // Native AEC is mandatory here: no HAL/software substitution. Reuse the
    // existing callback; IPC and serialization occur outside CoreAudio's callback.
    let stream = super::stream::build_input_stream(
        &native_device,
        &config,
        config.channels(),
        tx,
        move |error| {
            // Render errors can be transient during route reconfiguration.
            // Preserve the existing policy: device loss stops immediately;
            // absent callbacks are handled by the parent's sample watchdog.
            if matches!(error, cpal::StreamError::DeviceNotAvailable) {
                failure.store(true, Ordering::Relaxed);
            }
        },
        false,
        true,
    )?;
    stream.play()?;
    let output = std::io::stdout();
    let mut stdout = BufWriter::with_capacity(MAX_SAMPLES * 4 + 4, output.lock());
    writeln!(stdout, "{MAGIC} {}", config.sample_rate().0)?;
    stdout.flush()?;
    while !stopping.load(Ordering::Relaxed) && !failed.load(Ordering::Relaxed) {
        tokio::select! {
            sample = rx.recv() => match sample {
                Ok(samples) if !samples.is_empty() => {
                    if samples.len() > MAX_SAMPLES { bail!("native callback exceeds packet limit"); }
                    stdout.write_all(&(samples.len() as u32).to_le_bytes())?;
                    for sample in samples { stdout.write_all(&sample.to_le_bytes())?; }
                    stdout.flush()?;
                }
                Ok(_) | Err(broadcast::error::RecvError::Lagged(_)) => {},
                Err(error) => return Err(error.into()),
            },
            _ = tokio::time::sleep(Duration::from_millis(20)) => {},
        }
    }
    stream.pause()?;
    drop(stream);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::core::device::{default_input_device, DeviceType};

    #[test]
    #[ignore = "private subprocess entry; invoked by supervisor tests"]
    fn child_entry() {
        if let Ok(path) = std::env::var("SCREENPIPE_TEST_AEC_PID") {
            std::fs::write(path, std::process::id().to_string()).unwrap();
        }
        let device = std::env::var("SCREENPIPE_TEST_AEC_DEVICE").unwrap();
        if let Ok(fault) = std::env::var("SCREENPIPE_TEST_AEC_FAULT") {
            if fault != "open" {
                let mut out = std::io::stdout();
                writeln!(out, "{MAGIC} 16000").unwrap();
                out.write_all(&1u32.to_le_bytes()).unwrap();
                out.write_all(&0.25f32.to_le_bytes()).unwrap();
                out.flush().unwrap();
            }
            // Model a native open/dispose that never returns. The parent must
            // reap this actual process, not just abandon a task or JoinHandle.
            loop {
                std::thread::park();
            }
        }
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();
        let result = runtime.block_on(capture(&device));
        if let Err(error) = &result {
            eprintln!("{error:#}");
        }
        std::process::exit(if result.is_ok() { 0 } else { 1 });
    }

    fn fixture_command(dir: &std::path::Path, fault: Option<&str>) -> Command {
        let device = AudioDevice::new("test mic".into(), DeviceType::Input);
        let mut cmd = command(&device).unwrap();
        cmd.env("SCREENPIPE_TEST_AEC_PID", dir.join("pid"));
        if let Some(fault) = fault {
            cmd.env("SCREENPIPE_TEST_AEC_FAULT", fault);
        }
        cmd
    }

    fn pid(dir: &std::path::Path) -> i32 {
        std::fs::read_to_string(dir.join("pid"))
            .unwrap()
            .parse()
            .unwrap()
    }

    fn assert_reaped(pid: i32) {
        assert_eq!(
            unsafe { libc::kill(pid, 0) },
            -1,
            "capture process must be gone"
        );
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::ESRCH)
        );
    }

    async fn stop(control: &mpsc::Sender<StreamControl>, worker: tokio::task::JoinHandle<()>) {
        let (response, done) = oneshot::channel();
        control
            .send(StreamControl::Stop {
                _response: response,
                _mode: super::super::stream::StopMode::Immediate,
            })
            .unwrap();
        tokio::time::timeout(Duration::from_secs(3), done)
            .await
            .unwrap()
            .unwrap();
        tokio::time::timeout(Duration::from_secs(1), worker)
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn blocked_native_disposal_is_reaped_before_stop_acknowledgement() {
        let dir = tempfile::tempdir().unwrap();
        let (tx, _) = broadcast::channel(16);
        let (control, controls) = mpsc::channel();
        let (_, worker) = start_command(
            fixture_command(dir.path(), Some("stop")),
            tx,
            controls,
            Arc::new(AtomicBool::new(false)),
            Duration::from_secs(3),
        )
        .await
        .unwrap();
        let child_pid = pid(dir.path());
        stop(&control, worker).await;
        assert_reaped(child_pid);
    }

    #[tokio::test]
    async fn blocked_native_construction_is_reaped_before_startup_error() {
        let dir = tempfile::tempdir().unwrap();
        let (tx, _) = broadcast::channel(16);
        let (_control, controls) = mpsc::channel();
        let result = start_command(
            fixture_command(dir.path(), Some("open")),
            tx,
            controls,
            Arc::new(AtomicBool::new(false)),
            Duration::from_secs(1),
        )
        .await;
        assert!(result.is_err());
        assert_reaped(pid(dir.path()));
    }

    #[tokio::test]
    async fn cancelling_startup_reaps_the_owned_process() {
        let dir = tempfile::tempdir().unwrap();
        let (tx, _) = broadcast::channel(16);
        let (control, controls) = mpsc::channel();
        let task = tokio::spawn(start_command(
            fixture_command(dir.path(), Some("open")),
            tx,
            controls,
            Arc::new(AtomicBool::new(false)),
            Duration::from_secs(30),
        ));
        tokio::time::timeout(Duration::from_secs(3), async {
            while !dir.path().join("pid").exists() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .unwrap();
        let child_pid = pid(dir.path());
        task.abort();
        let _ = task.await;
        drop(control);
        tokio::time::timeout(Duration::from_secs(3), async {
            while unsafe { libc::kill(child_pid, 0) } == 0 {
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .unwrap();
        assert_reaped(child_pid);
    }

    #[test]
    fn malformed_worker_packets_cannot_allocate_unbounded_audio() {
        let mut bytes = b"SPVPIO1 48000\n".to_vec();
        bytes.extend_from_slice(&u32::MAX.to_le_bytes());
        let (tx, rx) = mpsc::sync_channel(4);
        assert!(read_packets(bytes.as_slice(), &tx).is_err());
        assert!(matches!(rx.recv().unwrap().unwrap(), Packet::Ready(_)));
        assert!(rx.try_recv().is_err());
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    #[ignore = "opens native AEC microphone and freezes only its own child"]
    async fn live_native_aec_recovers_after_frozen_worker_and_persists_samples() -> Result<()> {
        use crate::utils::ffmpeg::{read_audio_from_file, write_audio_to_file};
        let device = default_input_device()?;
        let dir = tempfile::tempdir()?;
        for cycle in 0..3 {
            let cycle_dir = dir.path().join(cycle.to_string());
            std::fs::create_dir(&cycle_dir)?;
            let mut cmd = command(&device)?;
            cmd.env("SCREENPIPE_TEST_AEC_PID", cycle_dir.join("pid"));
            let (tx, mut audio) = broadcast::channel(100);
            let (control, controls) = mpsc::channel();
            let capture_failed = Arc::new(AtomicBool::new(false));
            let (config, worker) =
                start_command(cmd, tx, controls, capture_failed.clone(), START_TIMEOUT).await?;
            let samples = tokio::time::timeout(Duration::from_secs(5), async {
                let mut samples = Vec::new();
                while samples.len() < config.sample_rate().0 as usize / 2 {
                    samples.extend(audio.recv().await?);
                }
                Ok::<_, anyhow::Error>(samples)
            })
            .await??;
            let path = cycle_dir.join("capture.m4a");
            write_audio_to_file(&samples, config.sample_rate().0, &path, false)?;
            let (decoded, rate) = read_audio_from_file(&path)?;
            let expected = samples.len() * rate as usize / config.sample_rate().0 as usize;
            assert!(decoded.len() >= expected);
            let child_pid = pid(&cycle_dir);
            // SIGSTOP freezes every thread, including any native stop call.
            // This deterministic failure cannot be recovered with a Rust timeout.
            assert_eq!(unsafe { libc::kill(child_pid, libc::SIGSTOP) }, 0);
            let started = Instant::now();
            if cycle == 1 {
                // No stop request: the callback watchdog itself must dispose
                // of the dead native worker so normal device recovery can run.
                tokio::time::timeout(SAMPLE_TIMEOUT + Duration::from_secs(3), worker)
                    .await
                    .context("missing callbacks did not trigger native recovery")??;
                assert!(capture_failed.load(Ordering::Relaxed));
            } else {
                stop(&control, worker).await;
            }
            assert_reaped(child_pid);
            println!(
                "native AEC cycle {cycle}: captured={}, decoded={}, frozen worker reaped in {:?}",
                samples.len(),
                decoded.len(),
                started.elapsed()
            );
        }
        Ok(())
    }
}
