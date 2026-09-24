// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Observed dependency and startup state. Snapshot reads never discover binaries,
//! spawn processes, download models, or touch disk. Instrumentation belongs at
//! startup and process/model lifecycle boundaries, never in capture callbacks.

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::{LazyLock, Mutex};

fn now() -> i64 {
    chrono::Utc::now().timestamp()
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Fault {
    pub subsystem: String,
    pub code: String,
    pub severity: String,
    pub detail: String,
    pub remedy: String,
    pub since: Option<i64>,
}
impl Fault {
    pub fn new(subsystem: &str, code: &str, detail: &str, remedy: &str) -> Self {
        Self {
            subsystem: subsystem.into(),
            code: code.into(),
            severity: "warning".into(),
            detail: detail.into(),
            remedy: remedy.into(),
            since: None,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Component {
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub engine: Option<String>,
    pub path: Option<PathBuf>,
    pub source: String,
    pub version: Option<String>,
    pub error: Option<String>,
    pub error_at: Option<i64>,
}
impl Default for Component {
    fn default() -> Self {
        Self {
            status: "unknown".into(),
            engine: None,
            path: None,
            source: "unknown".into(),
            version: None,
            error: None,
            error_at: None,
        }
    }
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct ProcessSnapshot {
    pub hd_encoders_running: u64,
    pub audio_encodes_running: u64,
    pub audio_encodes_last_minute: u64,
    pub audio_encode_failures_last_minute: u64,
    pub extractions_running: u64,
    pub extractions_queued: Option<u64>,
    pub compaction_running: bool,
    pub stalls_total: u64,
    pub last_stall_at: Option<i64>,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct FfmpegSnapshot {
    #[serde(flatten)]
    pub binary: Component,
    pub install_in_progress: bool,
    pub install_retry_after: Option<i64>,
    pub last_spawn_error: Option<String>,
    pub last_spawn_error_at: Option<i64>,
    pub processes: ProcessSnapshot,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct FailedStart {
    pub at: i64,
    pub phase: String,
    pub reason: String,
    pub detail: String,
    pub exit_code: Option<i32>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Preflight {
    pub check: String,
    pub result: String,
    pub detail: Option<String>,
    pub remedy: Option<String>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Environment {
    pub data_dir_writable: Option<bool>,
    pub path_has_ffmpeg: Option<bool>,
    pub env_overrides: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Startup {
    pub phase: String,
    pub phase_since: i64,
    pub engine_started_at: Option<i64>,
    pub preflight: Vec<Preflight>,
    pub last_failed_start: Option<FailedStart>,
    pub environment: Environment,
}
impl Default for Startup {
    fn default() -> Self {
        Self {
            phase: "idle".into(),
            phase_since: now(),
            engine_started_at: None,
            preflight: vec![],
            last_failed_start: None,
            environment: Environment::default(),
        }
    }
}

#[derive(Default)]
struct State {
    ffmpeg: FfmpegSnapshot,
    ffprobe: Component,
    models: BTreeMap<String, Component>,
    runtime: BTreeMap<String, Component>,
    startup: Startup,
    startup_path: Option<PathBuf>,
    audio_completions: VecDeque<(i64, bool)>,
    compactions: u64,
    media_required: Option<bool>,
    model_generation: u64,
    last_hd_success: Option<i64>,
    // A success in one pipeline must not clear a failure in another.
    media_failures: BTreeMap<String, (i64, String)>,
}
static STATE: LazyLock<Mutex<State>> = LazyLock::new(|| Mutex::new(State::default()));
fn state() -> std::sync::MutexGuard<'static, State> {
    STATE.lock().unwrap_or_else(|e| e.into_inner())
}

pub fn configure_media_required(required: bool) {
    state().media_required = Some(required);
}

pub fn binary_resolved(path: &Path, source: &str, probe: Option<PathBuf>) {
    let mut s = state();
    if s.ffmpeg.binary.path.as_deref() != Some(path) {
        s.ffmpeg.binary.version = None;
    }
    s.ffmpeg.binary.path = Some(path.into());
    s.ffmpeg.binary.source = source.into();
    s.ffmpeg.binary.status = "ok".into();
    s.ffmpeg.binary.error = None;
    s.ffmpeg.install_in_progress = false;
    s.ffmpeg.install_retry_after = None;
    s.ffprobe.status = if probe.is_some() { "ok" } else { "missing" }.into();
    s.ffprobe.path = probe;
}
pub fn binary_version(path: &Path, version: Option<String>, error: Option<String>) {
    let mut s = state();
    if s.ffmpeg.binary.path.as_deref() != Some(path) {
        return;
    }
    s.ffmpeg.binary.version = version;
    s.ffmpeg.binary.error = error;
    if s.ffmpeg.binary.error.is_some() {
        s.ffmpeg.binary.status = "spawn_failing".into();
        s.ffmpeg.binary.error_at = Some(now());
    }
}
pub fn binary_installing() {
    let mut s = state();
    s.ffmpeg.binary.status = "installing".into();
    s.ffmpeg.install_in_progress = true;
}
pub fn binary_install_failed(error: &str, retry_secs: i64) {
    let mut s = state();
    s.ffmpeg.binary.status = "install_failed".into();
    s.ffmpeg.binary.error = Some(error.into());
    s.ffmpeg.binary.error_at = Some(now());
    s.ffmpeg.install_in_progress = false;
    s.ffmpeg.install_retry_after = Some(now() + retry_secs);
}

/// Scope a process lifetime, including cancellation. Only spawn/finish boundaries
/// take a lock; no per-frame counters or allocations are added.
pub struct MediaOperation {
    kind: &'static str,
}
impl MediaOperation {
    pub fn start(kind: &'static str) -> Self {
        let mut s = state();
        s.media_required = Some(true);
        match kind {
            "audio" => s.ffmpeg.processes.audio_encodes_running += 1,
            "hd" => s.ffmpeg.processes.hd_encoders_running += 1,
            "extraction" => s.ffmpeg.processes.extractions_running += 1,
            "compaction" => s.compactions += 1,
            _ => {}
        }
        Self { kind }
    }
    pub fn finish<T, E: std::fmt::Display>(&self, result: &Result<T, E>) {
        let mut s = state();
        let at = now();
        if self.kind == "audio" {
            s.audio_completions.retain(|(t, _)| at - t < 60);
            if s.audio_completions.len() == 4096 {
                s.audio_completions.pop_front();
            }
            s.audio_completions.push_back((at, result.is_err()));
        }
        match result {
            Ok(_) => {
                s.media_failures.remove(self.kind);
                if self.kind == "hd" {
                    s.last_hd_success = Some(at);
                }
                if s.ffmpeg.binary.status == "spawn_failing" {
                    s.ffmpeg.binary.status = "ok".into();
                    s.ffmpeg.binary.error = None;
                    s.ffmpeg.binary.error_at = None;
                }
            }
            Err(e) => {
                let error: String = e.to_string().chars().take(2048).collect();
                s.ffmpeg.last_spawn_error = Some(error.clone());
                s.ffmpeg.last_spawn_error_at = Some(at);
                s.media_failures.insert(self.kind.into(), (at, error));
            }
        }
    }
}
impl Drop for MediaOperation {
    fn drop(&mut self) {
        let mut s = state();
        match self.kind {
            "audio" => {
                s.ffmpeg.processes.audio_encodes_running =
                    s.ffmpeg.processes.audio_encodes_running.saturating_sub(1)
            }
            "hd" => {
                s.ffmpeg.processes.hd_encoders_running =
                    s.ffmpeg.processes.hd_encoders_running.saturating_sub(1)
            }
            "extraction" => {
                s.ffmpeg.processes.extractions_running =
                    s.ffmpeg.processes.extractions_running.saturating_sub(1)
            }
            "compaction" => s.compactions = s.compactions.saturating_sub(1),
            _ => {}
        }
    }
}
pub fn media_stall() {
    let mut s = state();
    s.ffmpeg.processes.stalls_total += 1;
    s.ffmpeg.processes.last_stall_at = Some(now());
}

pub fn begin_transcription_model(engine: &str) -> u64 {
    let mut s = state();
    s.model_generation += 1;
    s.models.insert(
        "transcription".into(),
        Component {
            status: "initializing".into(),
            engine: Some(engine.into()),
            ..Component::default()
        },
    );
    s.model_generation
}
pub fn transcription_model_state(
    generation: u64,
    status: &str,
    path: Option<PathBuf>,
    error: Option<String>,
) {
    let mut s = state();
    if s.model_generation != generation {
        return;
    }
    let c = s.models.entry("transcription".into()).or_default();
    c.status = status.into();
    c.path = path;
    c.error_at = error.as_ref().map(|_| now());
    c.error = error;
}

pub fn component_state(
    group: &str,
    name: &str,
    status: &str,
    path: Option<PathBuf>,
    error: Option<String>,
) {
    let mut s = state();
    let map = if group == "models" {
        &mut s.models
    } else {
        &mut s.runtime
    };
    let c = map.entry(name.into()).or_default();
    c.status = status.into();
    c.path = path;
    c.error_at = error.as_ref().map(|_| now());
    c.error = error;
}

fn write_startup(path: &Path, snapshot: &Startup) -> std::io::Result<()> {
    let mut f = tempfile::NamedTempFile::new_in(path.parent().unwrap())?;
    serde_json::to_writer(&mut f, snapshot)?;
    f.as_file().sync_all()?;
    f.persist(path).map_err(|e| e.error)?;
    Ok(())
}
fn persist(s: &mut State) {
    if let Some(path) = &s.startup_path {
        let ok = write_startup(path, &s.startup).is_ok();
        s.startup.environment.data_dir_writable = Some(ok);
    }
}
fn recover_startup(previous: Option<Startup>) -> Option<FailedStart> {
    previous.and_then(|p| {
        if !matches!(p.phase.as_str(), "ready" | "idle" | "error") {
            Some(FailedStart {
                at: p.phase_since,
                phase: p.phase,
                reason: "unknown".into(),
                detail: "previous startup did not reach ready; termination cause was not observed"
                    .into(),
                exit_code: None,
            })
        } else {
            p.last_failed_start
        }
    })
}
pub fn begin_startup(data_dir: &Path) {
    let path = data_dir.join("health-startup.json");
    let previous = std::fs::File::open(&path)
        .ok()
        .and_then(|f| serde_json::from_reader(f).ok());
    let mut s = state();
    s.models.clear();
    s.runtime.clear();
    s.model_generation += 1;
    s.media_failures.clear();
    s.startup = Startup {
        phase: "starting".into(),
        engine_started_at: Some(now()),
        last_failed_start: recover_startup(previous),
        ..Startup::default()
    };
    s.startup.environment.path_has_ffmpeg = Some(which::which("ffmpeg").is_ok());
    s.startup.environment.env_overrides = [
        "SCREENPIPE_FFMPEG_PATH",
        "ORT_DYLIB_PATH",
        "HF_HOME",
        "HF_HUB_CACHE",
    ]
    .into_iter()
    .filter(|name| std::env::var_os(name).is_some())
    .map(String::from)
    .collect();
    s.startup.environment.data_dir_writable = Some(true);
    s.startup_path = Some(path);
    persist(&mut s);
}
pub fn startup_phase(phase: &str) {
    let mut s = state();
    if s.startup.phase == phase {
        return;
    }
    let completed = match (s.startup.phase.as_str(), phase) {
        ("migrating_database", "building_audio") => Some("database"),
        ("building_audio", "starting_pipes") => Some("audio_initialization"),
        ("starting_pipes", "ready") => Some("server_start"),
        _ => None,
    };
    if let Some(check) = completed {
        s.startup.preflight.retain(|p| p.check != check);
        s.startup.preflight.push(Preflight {
            check: check.into(),
            result: "ok".into(),
            detail: None,
            remedy: None,
        });
    }
    s.startup.phase = phase.into();
    s.startup.phase_since = now();
    persist(&mut s);
}
pub fn startup_failure(reason: &str, detail: &str, exit_code: Option<i32>) {
    let mut s = state();
    if matches!(s.startup.phase.as_str(), "idle" | "ready" | "error") {
        return;
    }
    s.startup.last_failed_start = Some(FailedStart {
        at: now(),
        phase: s.startup.phase.clone(),
        reason: reason.into(),
        detail: detail.chars().take(2048).collect(),
        exit_code,
    });
    s.startup.phase = "error".into();
    s.startup.phase_since = now();
    persist(&mut s);
}
pub fn preflight(check: &str, result: &str, detail: Option<String>, remedy: Option<String>) {
    let mut s = state();
    s.startup.preflight.retain(|v| v.check != check);
    s.startup.preflight.push(Preflight {
        check: check.into(),
        result: result.into(),
        detail,
        remedy,
    });
    persist(&mut s);
}

#[derive(Clone, Serialize)]
pub struct Diagnostics {
    pub dependencies: serde_json::Value,
    pub runtime: serde_json::Value,
    pub startup: Startup,
    pub unhealthy_reasons: Vec<Fault>,
}
pub fn snapshot(audio_disabled: bool) -> Diagnostics {
    snapshot_from(&state(), audio_disabled)
}

fn snapshot_from(s: &State, audio_disabled: bool) -> Diagnostics {
    let mut ffmpeg = s.ffmpeg.clone();
    ffmpeg.processes.compaction_running = s.compactions > 0;
    ffmpeg.processes.audio_encodes_last_minute = s
        .audio_completions
        .iter()
        .filter(|(t, _)| now() - t < 60)
        .count() as u64;
    ffmpeg.processes.audio_encode_failures_last_minute = s
        .audio_completions
        .iter()
        .filter(|(t, failed)| *failed && now() - t < 60)
        .count() as u64;
    if s.media_failures
        .iter()
        .any(|(kind, (at, _))| now() - at < 180 && !(audio_disabled && kind == "audio"))
    {
        ffmpeg.binary.status = "spawn_failing".into();
    }
    if ffmpeg
        .processes
        .last_stall_at
        .is_some_and(|t| now() - t < 180 && s.last_hd_success.is_none_or(|success| success < t))
    {
        ffmpeg.binary.status = "stalled".into();
    }
    if s.media_required == Some(false) {
        ffmpeg.binary.status = "not_required".into();
    }
    let mut ffprobe = s.ffprobe.clone();
    if s.media_required == Some(false) {
        ffprobe.status = "not_required".into();
    }
    let mut models = s.models.clone();
    let mut runtime = s.runtime.clone();
    for name in [
        "transcription",
        "vad",
        "speaker_segmentation",
        "speaker_embedding",
    ] {
        let c = models.entry(name.into()).or_default();
        if audio_disabled {
            c.status = "not_required".into();
        }
    }
    if audio_disabled {
        for c in runtime.values_mut() {
            c.status = "not_required".into();
        }
    }
    let mut faults = vec![];
    // Unknown and first-run downloading are observations, not proven failures.
    for (name, c) in
        std::iter::once(("ffmpeg", &ffmpeg.binary)).chain(std::iter::once(("ffprobe", &ffprobe)))
    {
        if matches!(
            c.status.as_str(),
            "missing" | "install_failed" | "spawn_failing" | "stalled"
        ) {
            faults.push(Fault::new(
                "dependencies",
                &format!("{name}_{}", c.status),
                c.error
                    .as_deref()
                    .or(ffmpeg.last_spawn_error.as_deref())
                    .unwrap_or("media dependency unavailable"),
                "Install or repair the bundled ffmpeg/ffprobe pair, then retry recording.",
            ));
        }
    }
    for (group, components) in [("dependencies", &models), ("runtime", &runtime)] {
        for (name, c) in components {
            if matches!(
                c.status.as_str(),
                "load_failed"
                    | "init_failed"
                    | "download_failed"
                    | "init_timed_out"
                    | "unsupported"
            ) {
                let mut fault = Fault::new(group, &format!("{name}_{}", c.status), c.error.as_deref().unwrap_or("component unavailable"), "Check the configured local model and native runtime; retry initialization or select a supported transcription engine.");
                fault.since = c.error_at;
                faults.push(fault);
            }
        }
    }
    let compat = !crate::cpu_features::has_avx2();
    let avx2 = cfg!(target_arch = "x86_64").then(crate::cpu_features::has_avx2);
    let degraded_features: Vec<_> = runtime
        .iter()
        .filter(|(_, c)| matches!(c.status.as_str(), "init_failed" | "init_timed_out"))
        .map(|(name, _)| name.clone())
        .collect();
    let onnx_status = if audio_disabled {
        "not_required"
    } else if runtime.values().any(|c| c.status == "init_timed_out") {
        "init_timed_out"
    } else if !degraded_features.is_empty() {
        "init_failed"
    } else if !runtime.is_empty() && runtime.values().all(|c| c.status == "ok") {
        "ok"
    } else {
        "unknown"
    };
    Diagnostics {
        dependencies: serde_json::json!({"ffmpeg": ffmpeg, "ffprobe": ffprobe, "models": models}),
        runtime: serde_json::json!({
            "status": if faults.iter().any(|f| f.subsystem == "runtime") { "degraded" }
                else if onnx_status == "ok" || onnx_status == "not_required" { "ok" } else { "unknown" },
            "onnxruntime": {
                "status": onnx_status, "path": null, "source": "unknown", "version": null,
                "init_timed_out": onnx_status == "init_timed_out",
                "degraded_features": degraded_features, "initializations": runtime,
            },
            "cpu": { "avx2": avx2, "compat_mode": compat },
            "msvc_runtime": { "status": if cfg!(windows) { "unknown" } else { "not_required" } },
            "swift_runtime": { "status": if cfg!(target_os = "macos") { "unknown" } else { "not_required" } },
            "crash_dump_helper": { "status": if cfg!(windows) { "unknown" } else { "not_required" } },
        }),
        startup: s.startup.clone(),
        unhealthy_reasons: faults,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn health_diagnostics_process_guards_release_and_recover_per_pipeline() {
        let operation = MediaOperation::start("audio");
        operation.finish::<(), _>(&Err("synthetic spawn failure"));
        assert_eq!(
            snapshot(false).dependencies["ffmpeg"]["processes"]["audio_encodes_running"],
            1
        );
        let extraction = MediaOperation::start("extraction");
        extraction.finish::<_, &str>(&Ok(()));
        assert!(!snapshot(false).unhealthy_reasons.is_empty());
        drop(extraction);
        operation.finish::<_, &str>(&Ok(()));
        assert!(snapshot(false).unhealthy_reasons.is_empty());
        drop(operation);
        assert_eq!(
            snapshot(false).dependencies["ffmpeg"]["processes"]["audio_encodes_running"],
            0
        );
        let hd = MediaOperation::start("hd");
        media_stall();
        assert!(snapshot(false)
            .unhealthy_reasons
            .iter()
            .any(|f| f.code == "ffmpeg_stalled"));
        hd.finish::<_, &str>(&Ok(()));
        assert!(snapshot(false).unhealthy_reasons.is_empty());
        drop(hd);
        let old = begin_transcription_model("old engine");
        let current = begin_transcription_model("current engine");
        transcription_model_state(current, "ready", None, None);
        transcription_model_state(old, "download_failed", None, Some("late result".into()));
        assert_eq!(
            snapshot(false).dependencies["models"]["transcription"]["status"],
            "ready"
        );
        assert_eq!(
            snapshot(false).dependencies["models"]["transcription"]["engine"],
            "current engine"
        );
    }

    #[test]
    fn health_diagnostics_downloads_and_unknowns_are_not_faults() {
        let mut s = State::default();
        s.models.insert(
            "transcription".into(),
            Component {
                status: "downloading".into(),
                ..Component::default()
            },
        );
        assert!(snapshot_from(&s, false).unhealthy_reasons.is_empty());
        s.models.get_mut("transcription").unwrap().status = "download_failed".into();
        assert_eq!(
            snapshot_from(&s, false).unhealthy_reasons[0].code,
            "transcription_download_failed"
        );
        assert!(snapshot_from(&s, true).unhealthy_reasons.is_empty());
        s.models.get_mut("transcription").unwrap().status = "ready".into();
        assert!(snapshot_from(&s, false).unhealthy_reasons.is_empty());
    }

    #[test]
    fn health_diagnostics_failure_history_does_not_degrade_current_start() {
        let mut s = State::default();
        s.startup.last_failed_start = Some(FailedStart {
            at: 1,
            phase: "building_audio".into(),
            reason: "unknown".into(),
            detail: "old error".into(),
            exit_code: None,
        });
        assert!(snapshot_from(&s, false).unhealthy_reasons.is_empty());
    }

    #[test]
    fn health_diagnostics_unneeded_and_old_media_failures_are_benign() {
        let mut s = State::default();
        s.ffmpeg.binary.status = "install_failed".into();
        s.media_required = Some(false);
        assert!(snapshot_from(&s, true).unhealthy_reasons.is_empty());
        s.media_required = Some(true);
        assert_eq!(
            snapshot_from(&s, true).unhealthy_reasons[0].code,
            "ffmpeg_install_failed"
        );
        s.ffmpeg.binary.status = "ok".into();
        s.media_failures
            .insert("audio".into(), (now(), "spawn failed".into()));
        assert!(snapshot_from(&s, true).unhealthy_reasons.is_empty());
        assert!(!snapshot_from(&s, false).unhealthy_reasons.is_empty());
        s.media_failures
            .insert("audio".into(), (now() - 181, "old failure".into()));
        assert!(snapshot_from(&s, false).unhealthy_reasons.is_empty());
    }

    #[test]
    fn health_diagnostics_audio_counters_use_a_rolling_minute() {
        let mut s = State::default();
        s.audio_completions
            .extend([(now() - 70, true), (now(), true), (now(), false)]);
        let snapshot = snapshot_from(&s, false);
        assert_eq!(
            snapshot.dependencies["ffmpeg"]["processes"]["audio_encodes_last_minute"],
            2
        );
        assert_eq!(
            snapshot.dependencies["ffmpeg"]["processes"]["audio_encode_failures_last_minute"],
            1
        );
    }

    #[test]
    fn startup_failure_survives_successful_restart() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("health-startup.json");
        let failure = FailedStart {
            at: 1,
            phase: "building_audio".into(),
            reason: "unknown".into(),
            detail: "init failed".into(),
            exit_code: Some(1),
        };
        let old = Startup {
            phase: "ready".into(),
            last_failed_start: Some(failure),
            ..Startup::default()
        };
        write_startup(&path, &old).unwrap();
        let read = serde_json::from_reader(std::fs::File::open(path).unwrap()).unwrap();
        assert_eq!(recover_startup(Some(read)).unwrap().detail, "init failed");
    }
    #[test]
    fn interrupted_start_does_not_invent_a_termination_cause() {
        let old = Startup {
            phase: "migrating_database".into(),
            ..Startup::default()
        };
        let failed = recover_startup(Some(old)).unwrap();
        assert_eq!(failed.reason, "unknown");
        assert_eq!(failed.phase, "migrating_database");
        assert_eq!(failed.exit_code, None);
    }
    #[test]
    fn fresh_and_ready_starts_have_no_failure() {
        assert!(recover_startup(None).is_none());
        assert!(recover_startup(Some(Startup {
            phase: "ready".into(),
            ..Startup::default()
        }))
        .is_none());
    }
}
