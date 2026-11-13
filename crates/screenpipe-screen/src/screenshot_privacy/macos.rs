// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

use super::*;
use anyhow::{anyhow, ensure};
use cidre::{api, cv, ns, sc};
use once_cell::sync::Lazy;
use std::future::Future;
use std::sync::{
    atomic::{AtomicU64, Ordering},
    Arc, Mutex,
};
use std::time::Instant;
use tokio::sync::{watch, Notify, Semaphore};

// A synchronous native call may never return. Keep its permit in the worker
// after the outer timeout so it cannot accumulate replacement blocking workers.
static CAPTURE_SLOT: Lazy<Arc<CaptureSlot>> = Lazy::new(|| Arc::new(CaptureSlot::new()));
const DEADLINE: Duration = Duration::from_secs(5);
const QUEUE_DEADLINE: Duration = Duration::from_secs(1);

struct CaptureSlot {
    semaphore: Arc<Semaphore>,
    generation: AtomicU64,
    cancelled: Notify,
}

impl CaptureSlot {
    fn new() -> Self {
        Self {
            semaphore: Arc::new(Semaphore::new(1)),
            generation: AtomicU64::new(0),
            cancelled: Notify::new(),
        }
    }
}

struct CancelCaptureOnDrop {
    slot: Arc<CaptureSlot>,
    generation: u64,
}

impl Drop for CancelCaptureOnDrop {
    fn drop(&mut self) {
        // A completed worker may already have released its slot to a new
        // request. Cancel only our own generation, never the next capture.
        if self
            .slot
            .generation
            .compare_exchange(
                self.generation,
                self.generation.wrapping_add(1),
                Ordering::AcqRel,
                Ordering::Acquire,
            )
            .is_ok()
        {
            self.slot.cancelled.notify_waiters();
        }
    }
}

#[derive(Clone, PartialEq, Eq)]
struct Policy {
    filters: WindowFilters,
    sources: ExclusionSources,
    excluded_ids: Vec<u32>,
}

pub(super) struct Producer {
    policy: Arc<Policy>,
    frames: watch::Sender<Option<Arc<PreparedFrame>>>,
}

pub(super) async fn capture_filtered(
    monitor: &SafeMonitor,
    filters: &WindowFilters,
    sources: ExclusionSources,
    excluded_ids: &[u32],
    _fresh: bool,
) -> anyhow::Result<CapturedPixels> {
    ensure!(
        api::macos_available("14.0"),
        "window-filtered screenshots require macOS 14 or newer"
    );
    let mut excluded_ids = excluded_ids.to_vec();
    excluded_ids.sort_unstable();
    excluded_ids.dedup();
    let policy = Policy {
        filters: filters.clone(),
        sources,
        excluded_ids,
    };
    let (slot, producer) = loop {
        let slot = super::stream::slot(monitor.id());
        let producer = {
            let mut entry = slot.producer.lock().unwrap_or_else(|e| e.into_inner());
            match entry.as_ref() {
                Some(producer) if *producer.policy == policy => Some(producer.clone()),
                Some(_) => None,
                None => {
                    let (frames, _) = watch::channel(None);
                    let producer = Arc::new(Producer {
                        policy: Arc::new(policy.clone()),
                        frames,
                    });
                    *entry = Some(producer.clone());
                    tokio::spawn(produce(monitor.id(), slot.clone(), producer.clone()));
                    Some(producer)
                }
            }
        };
        if let Some(producer) = producer {
            break (slot, producer);
        }
        // A user configuration change starts a new policy generation. Scene
        // changes within that generation never revoke an already owned frame.
        super::stream::invalidate(monitor.id());
    };
    let frame = selected_frame(&slot, producer.frames.subscribe()).await?;
    capture_on_worker(CAPTURE_SLOT.clone(), DEADLINE, move || async move {
        ensure!(slot.is_active(), "screenshot capture invalidated");
        let rendered = frame.render()?;
        ensure!(
            slot.is_active(),
            "screenshot capture invalidated during rendering"
        );
        Ok(rendered)
    })
    .await
}

async fn selected_frame(
    slot: &Arc<super::stream::Slot>,
    mut frames: watch::Receiver<Option<Arc<PreparedFrame>>>,
) -> anyhow::Result<Arc<PreparedFrame>> {
    loop {
        let cancelled = slot.cancelled.notified();
        tokio::pin!(cancelled);
        cancelled.as_mut().enable();
        ensure!(slot.is_active(), "screenshot capture invalidated");
        if let Some(frame) = frames.borrow_and_update().clone() {
            return Ok(frame);
        }
        // An empty cache waits for its continuous producer. Event time and a
        // new privacy observation are never capture permissions or fallbacks.
        tokio::select! {
            result = frames.changed() => result.map_err(|_| anyhow!("screenshot producer stopped"))?,
            _ = &mut cancelled => {},
        }
    }
}

async fn produce(id: u32, slot: Arc<super::stream::Slot>, producer: Arc<Producer>) {
    // Native scene collection may wait for the stream. Give each monitor its
    // own single-flight containment; only selected frames use the shared pixel
    // rendering worker. A slow source cannot occupy another monitor's worker.
    let worker = Arc::new(CaptureSlot::new());
    let mut failure = None;
    while slot.is_active() {
        let started = Instant::now();
        let cancelled = slot.cancelled.notified();
        tokio::pin!(cancelled);
        cancelled.as_mut().enable();
        if !slot.is_active() {
            break;
        }
        let result = tokio::select! {
            biased;
            _ = &mut cancelled => break,
            result = capture_with_scene_retries(id, worker.clone(), || {
                let slot = slot.clone();
                let policy = producer.policy.clone();
                move || async move { prepare(id, policy, &slot).await }
            }) => result,
        };
        match result {
            Ok(frame) => {
                if failure.take().is_some() {
                    tracing::info!(
                        monitor_id = id,
                        screenshot_outcome = "cached",
                        "continuous screenshot source recovered"
                    );
                }
                producer.frames.send_replace(Some(Arc::new(frame)));
            }
            Err(error) => {
                let cause = format!("{error:#}");
                if failure.as_ref() != Some(&cause) {
                    tracing::warn!(monitor_id = id, error = %cause, screenshot_outcome = "waiting_for_stream",
                        cached_frame_available = producer.frames.borrow().is_some(),
                        "continuous screenshot source could not prepare the next frame");
                    failure = Some(cause);
                }
                // A previously prepared frame keeps its own policy and scene.
                // Native failure reopens only the source, never a snapshot API.
                super::stream::suspend(&slot);
            }
        }
        let cadence = Duration::from_secs_f64(1.0 / super::stream::frame_rate() as f64);
        tokio::select! {
            _ = &mut cancelled => break,
            _ = tokio::time::sleep(cadence.saturating_sub(started.elapsed())) => {},
        }
    }
    producer.frames.send_replace(None);
}

pub(super) async fn cached_preview(id: u32) -> anyhow::Result<Option<DynamicImage>> {
    let Some(slot) = super::stream::existing_slot(id) else {
        return Ok(None);
    };
    let frame = {
        let producer = slot.producer.lock().unwrap_or_else(|e| e.into_inner());
        let Some(producer) = producer.as_ref() else {
            return Ok(None);
        };
        let frame = producer.frames.borrow().clone();
        frame.ok_or_else(|| anyhow!("continuous screenshot source has no prepared preview yet"))?
    };
    capture_on_worker(CAPTURE_SLOT.clone(), DEADLINE, move || async move {
        ensure!(slot.is_active(), "screenshot preview invalidated");
        Ok(Some(frame.render()?.image))
    })
    .await
}

async fn capture_with_scene_retries<F, J, Fut, T>(
    monitor_id: u32,
    slot: Arc<CaptureSlot>,
    mut job: F,
) -> anyhow::Result<T>
where
    F: FnMut() -> J,
    J: FnOnce() -> Fut + Send + 'static,
    Fut: Future<Output = anyhow::Result<T>>,
    T: Clone + Send + 'static,
{
    // Each rejected attempt releases its worker before reselection, so a
    // changing display cannot reserve the slot across retries.
    retry_scene_changes(monitor_id, || {
        capture_on_worker(slot.clone(), DEADLINE, job())
    })
    .await
}

/// A scene transition invalidates the old selection, not permission to capture
/// the next safe scene. Re-resolve it within the request's existing queue/native
/// budget. Each completed attempt releases its worker before the next selection.
async fn retry_scene_changes<F, Fut, T>(monitor_id: u32, mut capture_job: F) -> anyhow::Result<T>
where
    F: FnMut() -> Fut,
    Fut: Future<Output = anyhow::Result<T>>,
{
    let started = Instant::now();
    let mut retries = 0_u64;
    let mut deadline: Option<RetryDeadline> = None;
    loop {
        let result = if let Some(deadline) = deadline {
            let expired = || {
                anyhow!(
                "window-filtered capture timed out while reselecting (elapsed_ms={}, native_budget_ms={}, queue_budget_ms={}); screenshot pixels unavailable; the next capture must reselect current privacy state",
                started.elapsed().as_millis(), deadline.budget.as_millis(), QUEUE_DEADLINE.as_millis(),
            )
            };
            if tokio::time::Instant::now() >= deadline.at {
                return Err(expired());
            }
            tokio::time::timeout_at(deadline.at, capture_job())
                .await
                .map_err(|_| expired())?
        } else {
            capture_job().await
        };
        match result {
            Ok(image) => {
                if retries > 0 {
                    tracing::info!(
                        monitor_id,
                        retries,
                        elapsed_ms = started.elapsed().as_millis() as u64,
                        screenshot_outcome = "captured",
                        "window-filtered capture recovered after scene change"
                    );
                }
                return Ok(image);
            }
            Err(error) => {
                if error.downcast_ref::<SceneChanged>().is_none() {
                    return Err(error);
                }
                if deadline.is_none() {
                    deadline = error.downcast_ref::<RetryDeadline>().copied();
                }
                retries += 1;
                if retries == 1 {
                    tracing::warn!(monitor_id, error = %error, screenshot_outcome = "retrying",
                        "window-filtered capture reselecting after scene change");
                }
                tokio::task::yield_now().await;
            }
        }
    }
}

#[derive(Debug)]
struct SceneChanged(&'static str);

impl std::fmt::Display for SceneChanged {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.0)
    }
}

impl std::error::Error for SceneChanged {}

#[derive(Clone, Copy, Debug)]
struct RetryDeadline {
    at: tokio::time::Instant,
    budget: Duration,
    reason: &'static str,
}

impl std::fmt::Display for RetryDeadline {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.reason)
    }
}

impl std::error::Error for RetryDeadline {}

// Preserve retry classification across the worker boundary while destroying
// native error objects inside their originating autorelease pool.
#[derive(Clone)]
enum WorkerFailure {
    Scene {
        marker: &'static str,
        detail: String,
    },
    Native(String),
}

impl WorkerFailure {
    fn from_error(error: anyhow::Error) -> Self {
        if let Some(scene) = error.downcast_ref::<SceneChanged>() {
            Self::Scene {
                marker: scene.0,
                detail: format!("{error:#}"),
            }
        } else {
            Self::Native(format!("{error:#}"))
        }
    }

    fn into_error(self) -> anyhow::Error {
        match self {
            Self::Scene { marker, detail } => {
                anyhow::Error::new(SceneChanged(marker)).context(detail)
            }
            Self::Native(detail) => anyhow::Error::msg(detail),
        }
    }
}

// Construct the future on its native worker: ScreenCaptureKit objects must stay
// on that thread and inside its autorelease pool.
async fn capture_on_worker<F, Fut, T>(
    slot: Arc<CaptureSlot>,
    deadline: Duration,
    capture_job: F,
) -> anyhow::Result<T>
where
    F: FnOnce() -> Fut + Send + 'static,
    Fut: Future<Output = anyhow::Result<T>>,
    T: Clone + Send + 'static,
{
    let permit = tokio::time::timeout(QUEUE_DEADLINE, slot.semaphore.clone().acquire_owned())
        .await
        .map_err(|_| anyhow!("window-filtered capture is still busy"))??;
    let generation = slot
        .generation
        .fetch_add(1, Ordering::AcqRel)
        .wrapping_add(1);
    let _cancel_on_drop = CancelCaptureOnDrop {
        slot: slot.clone(),
        generation,
    };
    let runtime = tokio::runtime::Handle::current();
    let work = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        cidre::objc::ar_pool(|| {
            runtime
                .block_on(async {
                    // Timing out the JoinHandle alone detaches a still-running
                    // worker. Bound the native completion future here so a lost
                    // callback drops that future and releases the capture slot.
                    let capture = tokio::time::timeout(deadline, capture_job());
                    tokio::pin!(capture);
                    loop {
                        // Register before checking the generation so a pause
                        // between the check and await cannot lose its wakeup.
                        let cancelled = slot.cancelled.notified();
                        tokio::pin!(cancelled);
                        cancelled.as_mut().enable();
                        if slot.generation.load(Ordering::Acquire) != generation {
                            return Err(anyhow!("window-filtered capture cancelled"));
                        }
                        tokio::select! {
                            biased;
                            _ = &mut cancelled => {},
                            result = &mut capture => return result.map_err(|_| anyhow!("window-filtered capture timed out"))?,
                        }
                    }
                })
                .map_err(WorkerFailure::from_error)
        })
    });
    // Keep the original native deadline and synchronous-call containment.
    // Later attempts share this first admission's deadline, including time
    // spent fairly yielding the worker to another display.
    let at = tokio::time::Instant::now() + deadline;
    let result = tokio::time::timeout_at(at, work)
        .await
        .map_err(|_| anyhow!("window-filtered capture timed out"))??;
    result.map_err(|failure| {
        let error = failure.into_error();
        if let Some(scene) = error.downcast_ref::<SceneChanged>() {
            let reason = scene.0;
            error.context(RetryDeadline {
                at,
                budget: deadline,
                reason,
            })
        } else {
            error
        }
    })
}

#[derive(Clone, Debug, PartialEq)]
struct Surface {
    id: u32,
    pid: i32,
    app: String,
    title: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    alpha: f64,
    layer: i64,
}

#[derive(Default)]
struct SharingControlCache {
    surfaces: Vec<Surface>,
    pids: Vec<i32>,
    ids: Arc<std::collections::HashSet<(u32, i32)>>,
    complete: bool,
}
static SHARING_CONTROLS: Lazy<Mutex<SharingControlCache>> =
    Lazy::new(|| Mutex::new(SharingControlCache::default()));
struct SharingControls {
    ids: Arc<std::collections::HashSet<(u32, i32)>>,
    complete: bool,
    cause: Option<String>,
}

fn sharing_controls(surfaces: &[Surface], pids: &[i32]) -> SharingControls {
    let mut cache = SHARING_CONTROLS.lock().unwrap_or_else(|e| e.into_inner());
    if cache.complete && cache.surfaces == surfaces && cache.pids == pids {
        return SharingControls {
            ids: cache.ids.clone(),
            complete: true,
            cause: None,
        };
    }
    let present: std::collections::HashSet<_> = surfaces
        .iter()
        .map(|surface| (surface.id, surface.pid))
        .collect();
    let mut ids: std::collections::HashSet<_> = cache
        .ids
        .iter()
        .copied()
        .filter(|id| present.contains(id))
        .collect();
    let mut cause = None;
    for &pid in pids {
        match screenpipe_a11y::platform::macos::window_sharing_control_ids(pid) {
            Ok(controls) => {
                ids.retain(|(_, owner)| *owner != pid);
                ids.extend(
                    controls
                        .into_iter()
                        .map(|id| (id, pid))
                        .filter(|id| present.contains(id)),
                );
            }
            Err(error) => {
                cause.get_or_insert_with(|| format!("pid={pid}: {error}"));
            }
        }
    }
    let complete = cause.is_none();
    let ids = Arc::new(ids);
    *cache = SharingControlCache {
        surfaces: surfaces.to_vec(),
        pids: pids.to_vec(),
        ids: ids.clone(),
        complete,
    };
    SharingControls {
        ids,
        complete,
        cause,
    }
}

fn same_composition(before: &[Surface], after: &[Surface]) -> bool {
    before.len() == after.len()
        && before.iter().zip(after).all(|(before, after)| {
            before.id == after.id
                && before.pid == after.pid
                && before.app == after.app
                && before.x == after.x
                && before.y == after.y
                && before.width == after.width
                && before.height == after.height
                && before.alpha == after.alpha
                && before.layer == after.layer
        })
}

fn same_dock_coverage(before: Option<&[Surface]>, after: Option<&[Surface]>) -> bool {
    match (before, after) {
        (None, None) => true,
        (Some(before), Some(after)) => same_composition(before, after),
        _ => false,
    }
}

/// Composition depends on identity, geometry and stacking order. A title
/// change matters only when it changes the policy used to select the pixels.
/// Compare with the verdict recorded before capture, not a second evaluation
/// of the old title against potentially changed native privacy state.
#[cfg(test)]
fn validate_scene(
    before: &[Surface],
    allowed: &[bool],
    after: &[Surface],
    filters: &WindowFilters,
    detector: Option<&dyn screenpipe_a11y::incognito::IncognitoDetector>,
) -> anyhow::Result<()> {
    validate_scene_excluding(before, allowed, after, filters, detector, &[])
}

fn validate_scene_excluding(
    before: &[Surface],
    allowed: &[bool],
    after: &[Surface],
    filters: &WindowFilters,
    detector: Option<&dyn screenpipe_a11y::incognito::IncognitoDetector>,
    excluded_ids: &[u32],
) -> anyhow::Result<()> {
    if before.len() != allowed.len() || !same_composition(before, after) {
        return Err(SceneChanged(
            "desktop scene changed during privacy capture (identity, geometry or stacking)",
        )
        .into());
    }
    for ((before, allowed), after) in before.iter().zip(allowed).zip(after) {
        if before.title != after.title {
            if before.title.is_empty() || after.title.is_empty() {
                return Err(SceneChanged(
                    "window title availability changed during privacy capture",
                )
                .into());
            }
            if *allowed
                != (!excluded_ids.contains(&after.id)
                    && window_allowed(filters, detector, &after.app, &after.title, after.pid))
            {
                return Err(SceneChanged("window privacy policy changed during capture").into());
            }
        }
    }
    Ok(())
}

/// WindowServer order is authoritative; SCShareableContent does not promise
/// stacking order. Include desktop and shell surfaces, not just layer-zero apps.
fn snapshot(display: cidre::cg::Rect) -> anyhow::Result<Vec<Surface>> {
    window_list(
        display,
        core_graphics::window::kCGWindowListOptionOnScreenOnly,
    )
}

fn window_list(display: cidre::cg::Rect, options: u32) -> anyhow::Result<Vec<Surface>> {
    use core_foundation::{
        base::{CFType, TCFType},
        dictionary::CFDictionary,
        number::CFNumber,
        string::CFString,
    };
    use core_graphics::window::{copy_window_info, kCGNullWindowID};
    let list = copy_window_info(options, kCGNullWindowID)
        .ok_or_else(|| anyhow!("window scene unavailable"))?;
    let mut result = Vec::new();
    for ptr in list.iter() {
        let dict: CFDictionary<CFString, CFType> =
            unsafe { CFDictionary::wrap_under_get_rule(*ptr as _) };
        let number = |key: &str| -> Option<f64> {
            dict.find(CFString::new(key))?
                .downcast::<CFNumber>()?
                .to_f64()
        };
        let text = |key: &str| -> String {
            dict.find(CFString::new(key))
                .and_then(|v| v.downcast::<CFString>())
                .map(|s| s.to_string())
                .unwrap_or_default()
        };
        let bounds = dict
            .find(CFString::new("kCGWindowBounds"))
            .and_then(|v| v.downcast::<CFDictionary>())
            .map(|d| unsafe {
                CFDictionary::<CFString, CFType>::wrap_under_get_rule(d.as_concrete_TypeRef())
            })
            .ok_or_else(|| anyhow!("window geometry unavailable"))?;
        let bound = |key: &str| -> anyhow::Result<f64> {
            bounds
                .find(CFString::new(key))
                .and_then(|v| v.downcast::<CFNumber>())
                .and_then(|n| n.to_f64())
                .ok_or_else(|| anyhow!("invalid window geometry"))
        };
        let (x, y, width, height) = (bound("X")?, bound("Y")?, bound("Width")?, bound("Height")?);
        let alpha = number("kCGWindowAlpha").unwrap_or(1.0);
        let layer = number("kCGWindowLayer").unwrap_or(0.0) as i64;
        ensure!(
            [x, y, width, height, alpha].iter().all(|v| v.is_finite()),
            "non-finite window geometry"
        );
        if width <= 0.0 || height <= 0.0 || alpha <= 0.0 || layer == 2147483630 {
            continue;
        }
        if options != core_graphics::window::kCGWindowListOptionAll
            && (x + width <= display.origin.x
                || y + height <= display.origin.y
                || x >= display.origin.x + display.size.width
                || y >= display.origin.y + display.size.height)
        {
            continue;
        }
        result.push(Surface {
            id: number("kCGWindowNumber").ok_or_else(|| anyhow!("window id unavailable"))? as u32,
            pid: number("kCGWindowOwnerPID").unwrap_or(0.0) as i32,
            app: text("kCGWindowOwnerName"),
            title: text("kCGWindowName"),
            x,
            y,
            width,
            height,
            alpha,
            layer,
        });
    }
    result.reverse(); // bottom-to-top
    Ok(result)
}

/// Dock thumbnails can reproduce excluded windows. If native tile inspection
/// fails, omit Dock coverage instead of trusting its mirrored app pixels.
fn dock_masks(
    dock_pid: Option<i32>,
    display: cidre::cg::Rect,
    filters: &WindowFilters,
    detector: Option<&dyn screenpipe_a11y::incognito::IncognitoDetector>,
) -> Option<Vec<Surface>> {
    use cidre::{ax, cf};
    let Some(pid) = dock_pid else {
        return Some(Vec::new());
    };
    if !ax::is_process_trusted() {
        return None;
    }
    let app = ax::UiElement::with_app_pid(pid);
    app.set_messaging_timeout_secs(0.1).ok()?;
    let groups = app.children().ok()?;
    let windows = window_list(display, core_graphics::window::kCGWindowListOptionAll).ok()?;
    let text = |element: &ax::UiElement, attr: &ax::Attr| -> Option<String> {
        let value = element.attr_value(attr).ok()?;
        if value.get_type_id() != cf::String::type_id() {
            return None;
        }
        let value: &cf::String = unsafe { std::mem::transmute(&*value) };
        Some(value.to_string())
    };
    let mut masks = Vec::new();
    let mut seen = 0;
    for group in groups.iter() {
        group.set_messaging_timeout_secs(0.1).ok()?;
        let children = group.children().ok()?;
        for tile in children.iter() {
            seen += 1;
            if seen > 512 {
                return None;
            }
            tile.set_messaging_timeout_secs(0.1).ok()?;
            if text(tile, ax::attr::subrole()).as_deref() != Some("AXMinimizedWindowDockItem") {
                continue;
            }
            let title = text(tile, ax::attr::title())?;
            let matches: Vec<_> = windows.iter().filter(|w| w.title == title).collect();
            if !matches.is_empty()
                && matches
                    .iter()
                    .all(|w| window_allowed(filters, detector, &w.app, &w.title, w.pid))
            {
                continue;
            }
            let pos = tile.pos().ok()?.cg_point()?;
            let size = tile.size().ok()?.cg_size()?;
            if ![pos.x, pos.y, size.width, size.height]
                .iter()
                .all(|v| v.is_finite())
                || size.width <= 0.0
                || size.height <= 0.0
            {
                return None;
            }
            masks.push(Surface {
                id: 0,
                pid,
                app: "Dock".into(),
                title,
                x: pos.x,
                y: pos.y,
                width: size.width,
                height: size.height,
                alpha: 1.0,
                layer: 20,
            });
        }
    }
    Some(masks)
}

fn output_rect(
    surface: &Surface,
    display: cidre::cg::Rect,
    width: u32,
    height: u32,
) -> super::scene::Rect {
    let sx = f64::from(width) / display.size.width;
    let sy = f64::from(height) / display.size.height;
    let x = ((surface.x - display.origin.x) * sx).floor();
    let y = ((surface.y - display.origin.y) * sy).floor();
    super::scene::Rect {
        x: x as i64,
        y: y as i64,
        width: (((surface.x + surface.width - display.origin.x) * sx).ceil() - x).max(0.0) as u32,
        height: (((surface.y + surface.height - display.origin.y) * sy).ceil() - y).max(0.0) as u32,
    }
}

fn needs_occlusion_mask(
    surfaces: &[Surface],
    allowed: &[bool],
    index: usize,
    display: cidre::cg::Rect,
    width: u32,
    height: u32,
) -> bool {
    let rect = output_rect(&surfaces[index], display, width, height);
    surfaces[..index]
        .iter()
        .zip(&allowed[..index])
        .any(|(below, allowed)| {
            *allowed && output_rect(below, display, width, height).intersects(rect)
        })
}

#[derive(Clone)]
struct LayerImage {
    pixels: super::stream::NativeFrame,
    captured_at: chrono::DateTime<chrono::Utc>,
    native_timestamp: bool,
}

async fn sample_window_layer(
    filter: &sc::ContentFilter,
    width: usize,
    height: usize,
) -> anyhow::Result<LayerImage> {
    let mut cfg = sc::StreamCfg::new();
    cfg.set_width(width);
    cfg.set_height(height);
    cfg.set_pixel_format(cv::PixelFormat::_32_BGRA);
    cfg.set_shows_cursor(false);
    cfg.set_scales_to_fit(true);
    cfg.set_ignore_shadows_single_window(true);
    if api::macos_available("15.0") {
        cfg.set_show_mouse_clicks(false);
    }
    let sample = sc::ScreenshotManager::capture_sample_buf(filter, &cfg)
        .await
        .map_err(|e| anyhow!("screenshot scene layer ({width}x{height}): {e:?}"))?;
    let pixels = sample
        .image_buf()
        .ok_or_else(|| anyhow!("missing screenshot pixels"))?
        .retained();
    let received_at = chrono::Utc::now();
    let captured_at = super::stream::wall_timestamp(
        sample.pts(),
        cidre::cm::Clock::host_time_clock().time(),
        received_at,
    );
    let native_timestamp = captured_at.is_some();
    let captured_at = captured_at.unwrap_or(received_at);
    Ok(LayerImage {
        pixels: super::stream::NativeFrame(pixels),
        captured_at,
        native_timestamp,
    })
}

// The retained native pixels and every blackout/restoration operation travel
// together. Neither rendering nor event selection consults the live desktop.
#[derive(Clone)]
pub(super) struct SceneMetadata {
    surfaces: Vec<Surface>,
    allowed: Vec<bool>,
}

impl PartialEq for SceneMetadata {
    fn eq(&self, other: &Self) -> bool {
        self.allowed == other.allowed && same_composition(&self.surfaces, &other.surfaces)
    }
}

#[derive(Clone)]
struct PreparedFrame {
    policy: Arc<Policy>,
    scene: Arc<SceneMetadata>,
    width: usize,
    height: usize,
    base: Option<super::stream::NativeFrame>,
    operations: Vec<Draw>,
    captured_at: chrono::DateTime<chrono::Utc>,
    native_timestamp: bool,
}

#[derive(Clone)]
enum Draw {
    Black(super::scene::Rect),
    Coverage(super::scene::Rect, LayerImage),
    Restore(super::scene::Rect, LayerImage),
}

impl PreparedFrame {
    fn render(&self) -> anyhow::Result<CapturedPixels> {
        use super::scene::{self, Rect};
        debug_assert_eq!(self.scene.surfaces.len(), self.scene.allowed.len());
        // This frame retains the immutable policy and scene used by its plan.
        let _policy = &self.policy;
        let mut canvas = image::RgbaImage::from_pixel(
            self.width as u32,
            self.height as u32,
            image::Rgba([0, 0, 0, 255]),
        );
        if let Some(base) = &self.base {
            let mut buffer = base.clone();
            let pixels = rgba(&mut buffer.0)?.into_rgba8();
            scene::overlay_premultiplied(&mut canvas, &pixels, 0, 0, None);
        }
        let bounds = Rect {
            x: 0,
            y: 0,
            width: self.width as u32,
            height: self.height as u32,
        };
        let mut redacted = Vec::new();
        for operation in &self.operations {
            match operation {
                Draw::Black(rect) => {
                    scene::paint_black(&mut canvas, *rect);
                    if let Some(rect) = rect.intersection(bounds) {
                        redacted.push(scene::Redaction::Rect(rect));
                    }
                }
                Draw::Coverage(rect, layer) => {
                    let mut buffer = layer.pixels.clone();
                    let coverage = rgba(&mut buffer.0)?.into_rgba8();
                    if let Some(bounds) =
                        scene::paint_black_coverage(&mut canvas, &coverage, rect.x, rect.y)
                    {
                        redacted.push(scene::Redaction::Coverage {
                            bounds,
                            mask: coverage,
                            x: rect.x,
                            y: rect.y,
                        });
                    }
                }
                Draw::Restore(rect, layer) => {
                    let mut buffer = layer.pixels.clone();
                    let pixels = rgba(&mut buffer.0)?.into_rgba8();
                    scene::overlay_redacted(&mut canvas, &pixels, rect.x, rect.y, &redacted);
                }
            }
        }
        Ok(CapturedPixels {
            image: DynamicImage::ImageRgba8(canvas),
            captured_at: self.captured_at,
            native_timestamp: self.native_timestamp,
        })
    }
}

async fn prepare(
    id: u32,
    policy: Arc<Policy>,
    stream_slot: &Arc<super::stream::Slot>,
) -> anyhow::Result<PreparedFrame> {
    use super::scene::Rect;
    let filters = &policy.filters;
    let sources = policy.sources;
    ensure!(stream_slot.is_active(), "screenshot capture invalidated");
    let detector = sources
        .ignore_incognito_windows
        .then(|| screenpipe_a11y::incognito::create_detector(sources.enhanced_incognito_detection));
    let content = sc::ShareableContent::current()
        .await
        .map_err(|e| anyhow!("window enumeration: {e:?}"))?;
    let displays = content.displays();
    let display = displays
        .iter()
        .find(|d| d.display_id().0 == id)
        .ok_or_else(|| anyhow!("filtered display disappeared"))?;
    let frame = display.frame();
    let before = snapshot(frame)?;
    let available = content.windows();
    let native = |surface: &Surface| {
        available.iter().find(|w| {
            w.id() == surface.id
                && w.is_on_screen()
                && w.owning_app()
                    .is_some_and(|a| a.process_id() == surface.pid)
        })
    };
    let dock_pid = before.iter().filter(|s| s.layer == 20).find_map(|s| {
        native(s)
            .filter(|w| {
                w.owning_app()
                    .is_some_and(|a| a.bundle_id().to_string() == "com.apple.dock")
            })
            .map(|_| s.pid)
    });
    let dock_before = dock_masks(dock_pid, frame, filters, detector.as_deref());
    let allowed: Vec<bool> = before
        .iter()
        .map(|s| {
            native(s).is_some()
                && !policy.excluded_ids.contains(&s.id)
                && !(Some(s.pid) == dock_pid && s.layer == 20 && dock_before.is_none())
                && window_allowed(filters, detector.as_deref(), &s.app, &s.title, s.pid)
        })
        .collect();
    let mut pids: Vec<_> = before
        .iter()
        .zip(&allowed)
        // AppKit's observed sharing control belongs to a normal-level app
        // window. Shell/menu surfaces have no application AXWindows endpoint;
        // retain those surfaces normally rather than querying WindowServer.
        .filter_map(|(surface, allowed)| (*allowed && surface.layer == 0).then_some(surface.pid))
        .collect();
    pids.sort_unstable();
    pids.dedup();
    let controls = sharing_controls(&before, &pids);
    ensure!(
        controls.complete,
        "sharing-control scene metadata unavailable: {}",
        controls.cause.as_deref().unwrap_or("unknown native cause")
    );
    let (before, allowed): (Vec<_>, Vec<_>) = before
        .into_iter()
        .zip(allowed)
        .filter(|(surface, _)| !controls.ids.contains(&(surface.id, surface.pid)))
        .unzip();
    let selected: Vec<_> = before
        .iter()
        .zip(&allowed)
        .filter_map(|(s, ok)| {
            if *ok {
                native(s).map(|w| w.retained())
            } else {
                None
            }
        })
        .collect();
    let windows = ns::Array::from_slice_retained(&selected);
    let mut filter = sc::ContentFilter::with_display_including_windows(display, &windows);
    // SCDisplay dimensions are logical points on Retina displays. Preserve the
    // native pixel density before applying the user's explicit resolution cap.
    let scale = filter.point_pixel_scale() as f64;
    ensure!(
        scale.is_finite() && scale > 0.0,
        "invalid display pixel scale"
    );
    let nw = (frame.size.width * scale).round() as usize;
    let nh = (frame.size.height * scale).round() as usize;
    ensure!(
        nw > 0 && nh > 0 && nw <= 16384 && nh <= 16384,
        "invalid display dimensions"
    );
    let cap = crate::monitor::sck_capture_max_width() as usize;
    let width = if cap == 0 { nw } else { nw.min(cap) };
    let height = (nh * width / nw).max(1);
    let scene = Arc::new(SceneMetadata {
        surfaces: before.clone(),
        allowed: allowed.clone(),
    });
    let (base, mut captured_at, mut native_timestamp) = if selected.is_empty() {
        super::stream::suspend(stream_slot);
        (None, chrono::Utc::now(), false)
    } else {
        let menu_bar = before.iter().zip(&allowed).any(|(s, ok)| {
            *ok && s.layer == 24 && s.app == "Window Server" && s.title == "Menubar"
        });
        if api::macos_available("14.2") {
            filter.set_include_menu_bar(menu_bar);
        }
        let mut windows: Vec<_> = selected
            .iter()
            .map(|w| (w.id(), w.owning_app().map_or(0, |a| a.process_id())))
            .collect();
        windows.sort_unstable();
        let (pixels, captured_at, native_timestamp) = super::stream::frame(
            stream_slot,
            &filter,
            super::stream::Key {
                width,
                height,
                menu_bar,
                windows,
                fps: super::stream::frame_rate(),
                scene: scene.clone(),
            },
        )
        .await?;
        (Some(pixels), captured_at, native_timestamp)
    };
    let bounds = Rect {
        x: 0,
        y: 0,
        width: width as u32,
        height: height as u32,
    };
    let mut operations = Vec::new();
    let mut redacted = Vec::<Rect>::new();
    for (index, (surface, ok)) in before.iter().zip(&allowed).enumerate() {
        let rect = output_rect(surface, frame, width as u32, height as u32);
        if !*ok {
            // Native positive selection already omits excluded pixels, over
            // our black canvas. Mask only selected content underneath this
            // surface. An excluded bottommost wallpaper needs no mask; erasing
            // it again otherwise forces recapture of every foreground window.
            if !needs_occlusion_mask(&before, &allowed, index, frame, width as u32, height as u32) {
                continue;
            }
            // The system Dock owns a display-sized transparent overlay. Its
            // rectangle is not its visible coverage. Use only native alpha as
            // a mask; none of this excluded surface's RGB enters the output.
            let dock = native(surface).filter(|w| {
                surface.layer == 20
                    && w.owning_app()
                        .is_some_and(|a| a.bundle_id().to_string() == "com.apple.dock")
            });
            if let Some(dock) = dock {
                let filter = sc::ContentFilter::with_desktop_independent_window(dock);
                let coverage =
                    sample_window_layer(&filter, rect.width as usize, rect.height as usize)
                        .await
                        .map_err(|error| error.context("Dock alpha coverage sampling"))?;
                captured_at = captured_at.max(coverage.captured_at);
                native_timestamp &= coverage.native_timestamp;
                operations.push(Draw::Coverage(rect, coverage));
            } else {
                operations.push(Draw::Black(rect));
            }
            // Conservatively retain restoration layers overlapping a Dock
            // mask's bounds. Its precise alpha is read only for a saved frame.
            if let Some(clipped) = rect.intersection(bounds) {
                redacted.push(clipped);
            }
        } else if redacted.iter().any(|redaction| redaction.intersects(rect)) {
            // Restore only the affected part of an allowed foreground surface.
            // Capturing its native pixels preserves translucent corners without
            // revealing excluded pixels or repainting unrelated foreground UI.
            let window = native(surface).ok_or_else(|| anyhow!("allowed window disappeared"))?;
            let filter = sc::ContentFilter::with_desktop_independent_window(window);
            let pixels = sample_window_layer(&filter, rect.width as usize, rect.height as usize)
                .await
                .map_err(|error| error.context("allowed foreground restoration sampling"))?;
            captured_at = captured_at.max(pixels.captured_at);
            native_timestamp &= pixels.native_timestamp;
            operations.push(Draw::Restore(rect, pixels));
        }
    }
    if let Some(masks) = &dock_before {
        for mask in masks {
            operations.push(Draw::Black(output_rect(
                mask,
                frame,
                width as u32,
                height as u32,
            )));
        }
    }
    if !same_dock_coverage(
        dock_before.as_deref(),
        dock_masks(dock_pid, frame, filters, detector.as_deref()).as_deref(),
    ) {
        return Err(SceneChanged("Dock thumbnail policy changed during capture").into());
    }
    let after_scene = snapshot(frame)?;
    let after_controls = sharing_controls(&after_scene, &pids);
    let after_scene: Vec<_> = after_scene
        .into_iter()
        .filter(|surface| !after_controls.ids.contains(&(surface.id, surface.pid)))
        .collect();
    validate_scene_excluding(
        &before,
        &allowed,
        &after_scene,
        filters,
        detector.as_deref(),
        &policy.excluded_ids,
    )?;
    let after = sc::ShareableContent::current()
        .await
        .map_err(|e| anyhow!("window revalidation: {e:?}"))?;
    let after_windows = after.windows();
    for (s, ok) in before.iter().zip(&allowed) {
        if *ok {
            if !after_windows.iter().any(|w| {
                w.id() == s.id
                    && w.is_on_screen()
                    && w.owning_app().is_some_and(|a| a.process_id() == s.pid)
            }) {
                return Err(SceneChanged("allowed window changed during capture").into());
            }
        }
    }
    Ok(PreparedFrame {
        policy,
        scene,
        width,
        height,
        base,
        operations,
        captured_at,
        native_timestamp,
    })
}

pub(super) fn rgba(buf: &mut cv::ImageBuf) -> anyhow::Result<DynamicImage> {
    let (w, h) = (buf.width(), buf.height());
    ensure!(
        w > 0 && h > 0 && w <= 16384 && h <= 16384,
        "invalid screenshot dimensions"
    );
    ensure!(
        buf.plane_count() == 0 && buf.pixel_format() == cv::PixelFormat::_32_BGRA,
        "unexpected screenshot format"
    );
    let flags = cv::pixel_buffer::LockFlags::READ_ONLY;
    unsafe { buf.lock_base_addr(flags) }
        .result()
        .map_err(|e| anyhow!("pixel lock: {e:?}"))?;
    // Keep every fallible operation inside this closure so the unlock runs on
    // all error paths. The sample owns the buffer throughout the copy.
    let result = (|| {
        let stride = buf.bytes_per_row();
        let len = stride
            .checked_mul(h)
            .ok_or_else(|| anyhow!("pixel size overflow"))?;
        let ptr = unsafe { buf.base_address() } as *const u8;
        ensure!(
            !ptr.is_null() && stride >= w * 4 && len <= buf.data_size(),
            "invalid screenshot storage"
        );
        let data = unsafe { std::slice::from_raw_parts(ptr, len) };
        let mut image = image::RgbaImage::new(w as u32, h as u32);
        for (source, target) in data
            .chunks_exact(stride)
            .zip(image.as_mut().chunks_exact_mut(w * 4))
        {
            for (s, t) in source[..w * 4]
                .chunks_exact(4)
                .zip(target.chunks_exact_mut(4))
            {
                t.copy_from_slice(&[s[2], s[1], s[0], s[3]]);
            }
        }
        Ok(DynamicImage::ImageRgba8(image))
    })();
    unsafe { buf.unlock_lock_base_addr(flags) };
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicBool, Ordering};
    use tokio::sync::oneshot;

    fn surface(app: &str, title: &str) -> Surface {
        Surface {
            id: 42,
            pid: 123,
            app: app.into(),
            title: title.into(),
            x: 0.0,
            y: 0.0,
            width: 800.0,
            height: 600.0,
            alpha: 1.0,
            layer: 0,
        }
    }

    fn assert_pending<F: Future>(future: std::pin::Pin<&mut F>) {
        let mut context = std::task::Context::from_waker(std::task::Waker::noop());
        assert!(future.poll(&mut context).is_pending());
    }

    fn solid_buffer(
        width: usize,
        height: usize,
        bgra: [u8; 4],
    ) -> super::super::stream::NativeFrame {
        let mut pixels = cv::PixelBuf::new(width, height, cv::PixelFormat::_32_BGRA, None).unwrap();
        let flags = cv::pixel_buffer::LockFlags::DEFAULT;
        unsafe { pixels.lock_base_addr(flags) }.result().unwrap();
        let stride = pixels.bytes_per_row();
        let bytes = unsafe {
            std::slice::from_raw_parts_mut(pixels.base_address() as *mut u8, stride * height)
        };
        for row in bytes.chunks_exact_mut(stride) {
            for pixel in row[..width * 4].chunks_exact_mut(4) {
                pixel.copy_from_slice(&bgra);
            }
        }
        unsafe { pixels.unlock_lock_base_addr(flags) }
            .result()
            .unwrap();
        super::super::stream::NativeFrame(pixels)
    }

    fn prepared_for_test(at: chrono::DateTime<chrono::Utc>) -> PreparedFrame {
        PreparedFrame {
            policy: Arc::new(Policy {
                filters: WindowFilters::new(&["Private".into()], &[], &[]),
                sources: ExclusionSources::default(),
                excluded_ids: vec![],
            }),
            scene: Arc::new(SceneMetadata {
                surfaces: vec![
                    surface("TextEdit", "Public"),
                    Surface {
                        id: 43,
                        width: 4.0,
                        height: 8.0,
                        ..surface("TextEdit", "Private")
                    },
                ],
                allowed: vec![true, false],
            }),
            width: 8,
            height: 8,
            base: Some(solid_buffer(8, 8, [255, 255, 0, 255])),
            operations: vec![Draw::Black(super::super::scene::Rect {
                x: 0,
                y: 0,
                width: 4,
                height: 8,
            })],
            captured_at: at,
            native_timestamp: true,
        }
    }

    #[tokio::test]
    async fn cached_frame_keeps_its_scene_and_timestamp_after_the_live_scene_changes() {
        let slot = super::super::stream::slot(4_000_001_001);
        let at = chrono::Utc::now() - chrono::Duration::seconds(30);
        let prepared = Arc::new(prepared_for_test(at));
        let (frames, receiver) = watch::channel(Some(prepared.clone()));
        let mut live = prepared.scene.surfaces.clone();
        live[0].x += 100.0;
        live[0].title = "Private".into();
        assert!(validate_scene(
            &prepared.scene.surfaces,
            &prepared.scene.allowed,
            &live,
            &prepared.policy.filters,
            None
        )
        .is_err());
        let selected = selected_frame(&slot, receiver).await.unwrap();
        assert!(Arc::ptr_eq(&selected, &prepared));
        assert_eq!(selected.captured_at, at);
        assert_eq!(selected.scene.surfaces[0].x, 0.0);
        assert_eq!(selected.scene.surfaces[0].title, "Public");
        let rendered = selected.render().unwrap();
        assert_eq!(rendered.captured_at, at);
        let pixels = rendered.image.into_rgba8();
        assert_eq!(pixels.get_pixel(1, 1).0, [0, 0, 0, 255]);
        assert_eq!(pixels.get_pixel(6, 1).0, [0, 255, 255, 255]);
        drop(frames);
        super::super::stream::invalidate(4_000_001_001);
    }

    #[test]
    fn retained_foreground_and_dock_alpha_render_over_the_owned_blackout_plan() {
        use super::super::scene::Rect;
        let at = chrono::Utc::now();
        let mut frame = prepared_for_test(at);
        frame.operations.push(Draw::Restore(
            Rect {
                x: 0,
                y: 0,
                width: 2,
                height: 2,
            },
            LayerImage {
                pixels: solid_buffer(2, 2, [0, 128, 0, 128]),
                captured_at: at,
                native_timestamp: true,
            },
        ));
        frame.operations.push(Draw::Coverage(
            Rect {
                x: 6,
                y: 0,
                width: 2,
                height: 2,
            },
            LayerImage {
                pixels: solid_buffer(2, 2, [255, 0, 255, 255]),
                captured_at: at,
                native_timestamp: true,
            },
        ));
        let pixels = frame.render().unwrap().image.into_rgba8();
        assert_eq!(pixels.get_pixel(0, 0).0, [0, 128, 0, 255]);
        assert_eq!(pixels.get_pixel(3, 0).0, [0, 0, 0, 255]);
        assert_eq!(pixels.get_pixel(6, 0).0, [0, 0, 0, 255]);
        assert_eq!(pixels.get_pixel(6, 6).0, [0, 255, 255, 255]);
    }

    #[tokio::test]
    async fn empty_cache_waits_for_the_stream_and_event_cancellation_keeps_the_source() {
        let slot = super::super::stream::slot(4_000_001_002);
        let (frames, receiver) = watch::channel(None);
        let waiting = selected_frame(&slot, receiver.clone());
        tokio::pin!(waiting);
        assert_pending(waiting.as_mut());
        let prepared = Arc::new(prepared_for_test(chrono::Utc::now()));
        frames.send_replace(Some(prepared.clone()));
        assert!(Arc::ptr_eq(&waiting.await.unwrap(), &prepared));
        frames.send_replace(None);
        {
            let cancelled = selected_frame(&slot, receiver.clone());
            tokio::pin!(cancelled);
            assert_pending(cancelled.as_mut());
        }
        assert!(slot.is_active());
        let paused = selected_frame(&slot, receiver);
        tokio::pin!(paused);
        assert_pending(paused.as_mut());
        super::super::stream::invalidate(4_000_001_002);
        assert!(paused.await.is_err());
    }

    #[test]
    fn excluded_background_masks_only_selected_content_behind_it() {
        let display = cidre::cg::Rect {
            origin: cidre::cg::Point { x: 0.0, y: 0.0 },
            size: cidre::cg::Size {
                width: 1600.0,
                height: 1000.0,
            },
        };
        let private = surface("Dock", "Wallpaper-");
        let mut public = surface("TextEdit", "Public");
        public.id += 1;
        assert!(!needs_occlusion_mask(
            &[private.clone(), public.clone()],
            &[false, true],
            0,
            display,
            1600,
            1000
        ));
        assert!(needs_occlusion_mask(
            &[public.clone(), private.clone()],
            &[true, false],
            1,
            display,
            1600,
            1000
        ));
        public.x = 900.0;
        assert!(!needs_occlusion_mask(
            &[public.clone(), private.clone()],
            &[true, false],
            1,
            display,
            1600,
            1000
        ));
        // Preserve masking at fractional positions that share an output pixel.
        public.x = 799.5;
        public.width = 1.0;
        assert!(needs_occlusion_mask(
            &[public, private],
            &[true, false],
            1,
            display,
            1600,
            1000
        ));
    }

    #[test]
    fn title_changes_preserve_screenshots_when_selection_is_unchanged() {
        let filters = WindowFilters::new(&["whatsapp".into(), "zee5".into()], &[], &[]);
        for (app, allowed) in [("TextEdit", true), ("WhatsApp", false)] {
            let before = [surface(app, "Notes A")];
            let after = [surface(app, "Notes B")];
            validate_scene(&before, &[allowed], &after, &filters, None).unwrap();
        }
    }

    #[test]
    fn dock_title_changes_preserve_masks_but_coverage_and_verification_changes_reject() {
        let before = [surface("Dock", "Private A")];
        let renamed = [surface("Dock", "Private B")];
        assert!(same_dock_coverage(Some(&before), Some(&renamed)));
        let mut moved = renamed.clone();
        moved[0].x += 1.0;
        assert!(!same_dock_coverage(Some(&before), Some(&moved)));
        assert!(!same_dock_coverage(Some(&before), Some(&[])));
        assert!(!same_dock_coverage(Some(&before), None));
        assert!(!same_dock_coverage(None, Some(&renamed)));
        assert!(same_dock_coverage(None, None));
    }

    #[test]
    fn title_policy_transitions_are_withheld_and_next_safe_scene_recovers() {
        let policies = [
            WindowFilters::new(&["::Private".into()], &[], &[]),
            WindowFilters::new(&[], &["TextEdit::Public".into()], &[]),
            WindowFilters::new(&["whatsapp".into(), "zee5".into()], &[], &[]),
            WindowFilters::new(&["::Unrelated".into()], &[], &["private.example".into()]),
        ];
        for (filters, blocked_title) in
            policies
                .iter()
                .zip(["Private", "Private", "WhatsApp", "private.example"])
        {
            let public = [surface("TextEdit", "Public A")];
            let private = [surface("TextEdit", blocked_title)];
            for (before, allowed, after) in [(&public, true, &private), (&private, false, &public)]
            {
                let error = validate_scene(before, &[allowed], after, filters, None).unwrap_err();
                assert!(error.to_string().contains("privacy policy changed"));
            }
            let next = [surface("TextEdit", "Public B")];
            validate_scene(&public, &[true], &next, filters, None).unwrap();
        }
    }

    #[test]
    fn title_revalidation_uses_original_verdict_and_current_incognito_state() {
        struct Detector;
        impl screenpipe_a11y::incognito::IncognitoDetector for Detector {
            fn is_incognito(&self, _: &str, _: i32, _: &str) -> bool {
                true
            }
        }
        let filters = WindowFilters::new(&["::Unrelated".into()], &[], &[]);
        let before = [surface("Browser", "Page A")];
        let after = [surface("Browser", "Page B")];
        assert!(validate_scene(&before, &[true], &after, &filters, Some(&Detector)).is_err());
        // Native selection may have failed even though a title passes policy.
        // Do not turn that original rejection into permission after a rename.
        assert!(validate_scene(&before, &[false], &after, &filters, None).is_err());
        let unnamed = [surface("Browser", "")];
        assert!(validate_scene(&before, &[true], &unnamed, &filters, None).is_err());
        assert!(validate_scene(&unnamed, &[true], &after, &filters, None).is_err());
        validate_scene(&unnamed, &[true], &unnamed, &filters, None).unwrap();
    }

    #[test]
    fn composition_changes_still_withhold_screenshots() {
        let filters = WindowFilters::new(&["::Private".into()], &[], &[]);
        let original = surface("TextEdit", "Public");
        let mut changes = Vec::new();
        macro_rules! changed {
            ($field:ident, $value:expr) => {{
                let mut changed = original.clone();
                changed.$field = $value;
                changes.push(changed);
            }};
        }
        changed!(id, 43);
        changed!(pid, 124);
        changed!(app, "Other".into());
        changed!(x, -1.0);
        changed!(y, 1.0);
        changed!(width, 801.0);
        changed!(height, 601.0);
        changed!(alpha, 0.5);
        changed!(layer, 1);
        for changed in changes {
            assert!(
                validate_scene(&[original.clone()], &[true], &[changed], &filters, None).is_err()
            );
        }
        assert!(validate_scene(&[original.clone()], &[true], &[], &filters, None).is_err());
        let mut other = original.clone();
        other.id = 43;
        assert!(validate_scene(
            &[original.clone(), other.clone()],
            &[true, true],
            &[other, original],
            &filters,
            None,
        )
        .is_err());
    }

    #[tokio::test]
    async fn stable_capture_gets_a_turn_before_another_capture_retries() {
        let slot = Arc::new(CaptureSlot::new());
        let order = Arc::new(std::sync::Mutex::new(Vec::new()));
        let (started, ready) = oneshot::channel();
        let (release, released) = oneshot::channel();
        let changing_slot = slot.clone();
        let changing_order = order.clone();
        let changing = tokio::spawn(async move {
            let mut first = Some((started, released));
            capture_with_scene_retries(1, changing_slot, move || {
                let first = first.take();
                let order = changing_order.clone();
                move || async move {
                    if let Some((started, released)) = first {
                        order.lock().unwrap().push("changing");
                        let _ = started.send(());
                        let _ = released.await;
                        Err(SceneChanged("desktop scene changed during privacy capture").into())
                    } else {
                        order.lock().unwrap().push("retry");
                        Ok(DynamicImage::new_rgba8(3, 2))
                    }
                }
            })
            .await
        });
        ready.await.unwrap();
        let stable_order = order.clone();
        let stable = capture_with_scene_retries(2, slot, move || {
            let order = stable_order.clone();
            move || async move {
                order.lock().unwrap().push("stable");
                Ok(DynamicImage::new_rgba8(4, 2))
            }
        });
        tokio::pin!(stable);
        // Queue the second caller while the first native attempt still owns
        // the slot. Reselection must go behind this already-waiting work.
        std::future::poll_fn(|cx| {
            assert!(stable.as_mut().poll(cx).is_pending());
            std::task::Poll::Ready(())
        })
        .await;
        release.send(()).unwrap();
        assert_eq!(stable.await.unwrap().width(), 4);
        assert_eq!(changing.await.unwrap().unwrap().width(), 3);
        assert_eq!(*order.lock().unwrap(), ["changing", "stable", "retry"]);
    }

    #[tokio::test]
    async fn repeated_scene_changes_stop_at_total_request_budget_and_recover() {
        let slot = Arc::new(CaptureSlot::new());
        let result = tokio::time::timeout(
            QUEUE_DEADLINE + DEADLINE + QUEUE_DEADLINE,
            capture_with_scene_retries::<_, _, _, DynamicImage>(1, slot.clone(), || {
                || {
                    std::future::ready(Err(SceneChanged(
                        "desktop scene changed during privacy capture",
                    )
                    .into()))
                }
            }),
        )
        .await
        .expect("the request must not reset its deadline on each retry");
        let error = result.unwrap_err().to_string();
        assert!(error.contains("native_budget_ms=5000"), "{error}");
        assert!(error.contains("screenshot pixels unavailable"), "{error}");
        let next =
            capture_with_scene_retries(2, slot, || || async { Ok(DynamicImage::new_rgba8(3, 2)) })
                .await
                .unwrap();
        assert_eq!((next.width(), next.height()), (3, 2));
    }

    #[tokio::test]
    async fn scene_change_reselects_until_a_privacy_valid_image_is_available() {
        let filters = WindowFilters::new(&["::Private".into()], &[], &[]);
        let public = [surface("TextEdit", "Public")];
        let private = [surface("TextEdit", "Private")];
        let mut attempts = 0;
        let image = retry_scene_changes(1, || {
            attempts += 1;
            // First acquisition crosses a public-to-private policy change.
            // A fresh selection rejects that window before reading its pixels.
            let result = if attempts == 1 {
                validate_scene(&public, &[true], &private, &filters, None)
                    .map(|()| DynamicImage::new_rgba8(1, 1))
            } else {
                validate_scene(&private, &[false], &private, &filters, None).map(|()| {
                    DynamicImage::ImageRgba8(image::RgbaImage::from_pixel(
                        3,
                        2,
                        image::Rgba([0, 0, 0, 255]),
                    ))
                })
            };
            std::future::ready(result)
        })
        .await
        .unwrap();
        assert_eq!(attempts, 2);
        assert_eq!((image.width(), image.height()), (3, 2));
        assert!(image
            .to_rgba8()
            .pixels()
            .all(|pixel| pixel.0 == [0, 0, 0, 255]));
    }

    #[tokio::test]
    async fn scene_reselection_preserves_native_errors() {
        let mut attempts = 0;
        let error = retry_scene_changes::<_, _, DynamicImage>(1, || {
            attempts += 1;
            std::future::ready(Err(anyhow!("ScreenCaptureKit stream failed to start")))
        })
        .await
        .unwrap_err();
        assert_eq!(attempts, 1);
        assert_eq!(error.to_string(), "ScreenCaptureKit stream failed to start");
    }

    #[tokio::test]
    async fn continuous_scene_changes_respect_existing_deadline_and_recover() {
        let slot = Arc::new(CaptureSlot::new());
        let first = capture_on_worker::<_, _, DynamicImage>(
            slot.clone(),
            Duration::from_millis(50),
            || async {
                retry_scene_changes(1, || {
                    std::future::ready(Err(SceneChanged(
                        "desktop scene changed during privacy capture",
                    )
                    .into()))
                })
                .await
            },
        )
        .await;
        assert!(first.unwrap_err().to_string().contains("timed out"));
        let next = capture_on_worker(slot, Duration::from_secs(1), || async {
            Ok(DynamicImage::new_rgba8(3, 2))
        })
        .await
        .unwrap();
        assert_eq!((next.width(), next.height()), (3, 2));
    }

    #[tokio::test]
    async fn completing_old_request_does_not_cancel_next_capture() {
        let slot = Arc::new(CaptureSlot::new());
        let (first_started, first_ready) = oneshot::channel();
        let (finish_first, first_release) = oneshot::channel();
        let first = capture_on_worker(slot.clone(), DEADLINE, move || async move {
            let _ = first_started.send(());
            let _ = first_release.await;
            Ok(DynamicImage::new_rgba8(2, 2))
        });
        tokio::pin!(first);
        std::future::poll_fn(|cx| {
            assert!(first.as_mut().poll(cx).is_pending());
            std::task::Poll::Ready(())
        })
        .await;
        first_ready.await.unwrap();
        finish_first.send(()).unwrap();
        // The native worker has returned, but its async caller has not yet
        // consumed the result or dropped its cancellation guard.
        let free = slot.semaphore.clone().acquire_owned().await.unwrap();
        drop(free);
        let (second_started, second_ready) = oneshot::channel();
        let (finish_second, second_release) = oneshot::channel();
        let second = tokio::spawn(capture_on_worker(slot, DEADLINE, move || async move {
            let _ = second_started.send(());
            let _ = second_release.await;
            Ok(DynamicImage::new_rgba8(3, 2))
        }));
        second_ready.await.unwrap();
        first.await.unwrap();
        finish_second.send(()).unwrap();
        let image = second.await.unwrap().unwrap();
        assert_eq!((image.width(), image.height()), (3, 2));
    }

    #[tokio::test]
    async fn aborting_capture_cancels_native_work_during_reselection() {
        let slot = Arc::new(CaptureSlot::new());
        let (started, ready) = oneshot::channel();
        let attempts = Arc::new(AtomicU64::new(0));
        let attempt_count = attempts.clone();
        let dropped = Arc::new(AtomicBool::new(false));
        let native_dropped = dropped.clone();
        struct OnDrop(Arc<AtomicBool>);
        impl Drop for OnDrop {
            fn drop(&mut self) {
                self.0.store(true, Ordering::Release);
            }
        }
        let task = tokio::spawn(capture_on_worker(
            slot.clone(),
            DEADLINE,
            move || async move {
                let mut started = Some(started);
                retry_scene_changes(1, || {
                    let attempt = attempts.fetch_add(1, Ordering::AcqRel);
                    let started = if attempt == 1 { started.take() } else { None };
                    let native_dropped = native_dropped.clone();
                    async move {
                        if attempt == 0 {
                            return Err(SceneChanged(
                                "desktop scene changed during privacy capture",
                            )
                            .into());
                        }
                        let _on_drop = OnDrop(native_dropped);
                        if let Some(started) = started {
                            let _ = started.send(());
                        }
                        std::future::pending::<anyhow::Result<DynamicImage>>().await
                    }
                })
                .await
            },
        ));
        ready.await.unwrap();
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
        let next = capture_on_worker(slot, DEADLINE, || async {
            Ok(DynamicImage::new_rgba8(3, 2))
        })
        .await
        .unwrap();
        assert!(dropped.load(Ordering::Acquire));
        assert_eq!(attempt_count.load(Ordering::Acquire), 2);
        assert_eq!((next.width(), next.height()), (3, 2));
    }

    #[tokio::test]
    async fn stalled_completion_releases_slot_for_next_capture() {
        let slot = Arc::new(CaptureSlot::new());
        let (release, completion) = oneshot::channel::<()>();
        let cancelled = Arc::new(AtomicBool::new(false));
        let worker_cancelled = cancelled.clone();
        struct OnDrop(Arc<AtomicBool>);
        impl Drop for OnDrop {
            fn drop(&mut self) {
                self.0.store(true, Ordering::SeqCst);
            }
        }

        let first = capture_on_worker(
            slot.clone(),
            Duration::from_millis(50),
            move || async move {
                let _on_drop = OnDrop(worker_cancelled);
                let _ = completion.await;
                Ok(DynamicImage::new_rgba8(2, 2))
            },
        )
        .await;
        let second = capture_on_worker(slot.clone(), Duration::from_secs(1), || async {
            Ok(DynamicImage::new_rgba8(3, 2))
        })
        .await;
        let cancelled_before_late_completion = cancelled.load(Ordering::SeqCst);
        // Always unblock the old implementation before asserting so a failing
        // regression test cannot leave runtime shutdown waiting on its worker.
        let _ = release.send(());
        let _drained = tokio::time::timeout(
            Duration::from_secs(1),
            slot.semaphore.clone().acquire_owned(),
        )
        .await
        .expect("worker must drain after its completion is released")
        .unwrap();

        assert!(first.unwrap_err().to_string().contains("timed out"));
        let image = second.expect("next screenshot must succeed after a missing completion");
        assert_eq!((image.width(), image.height()), (3, 2));
        assert!(
            cancelled_before_late_completion,
            "timed-out native future must be dropped"
        );
    }

    #[tokio::test]
    async fn privacy_failure_is_returned_and_does_not_poison_next_capture() {
        let slot = Arc::new(CaptureSlot::new());
        let result = capture_on_worker::<_, _, DynamicImage>(
            slot.clone(),
            Duration::from_secs(1),
            || async { Err(anyhow!("desktop scene changed during privacy capture")) },
        )
        .await;
        assert_eq!(
            result.unwrap_err().to_string(),
            "desktop scene changed during privacy capture"
        );
        let image = capture_on_worker(slot, Duration::from_secs(1), || async {
            Ok(DynamicImage::new_rgba8(2, 2))
        })
        .await
        .unwrap();
        assert_eq!((image.width(), image.height()), (2, 2));
    }

    #[tokio::test]
    async fn synchronous_native_stall_does_not_spawn_replacement_workers() {
        let slot = Arc::new(CaptureSlot::new());
        let (release, blocked) = std::sync::mpsc::channel::<()>();
        let replacement_started = Arc::new(AtomicBool::new(false));
        let started = replacement_started.clone();
        let first = capture_on_worker(
            slot.clone(),
            Duration::from_millis(50),
            move || async move {
                // A synchronous native IPC cannot be cancelled by polling a timer.
                let _ = blocked.recv();
                Ok(DynamicImage::new_rgba8(2, 2))
            },
        )
        .await;
        let second = capture_on_worker(
            slot.clone(),
            Duration::from_millis(50),
            move || async move {
                started.store(true, Ordering::SeqCst);
                Ok(DynamicImage::new_rgba8(2, 2))
            },
        )
        .await;
        // Unblock before asserting, including when the regression fails.
        let _ = release.send(());
        let third = capture_on_worker(slot, Duration::from_secs(1), || async {
            Ok(DynamicImage::new_rgba8(2, 2))
        })
        .await;

        assert!(first.unwrap_err().to_string().contains("timed out"));
        assert!(second.unwrap_err().to_string().contains("still busy"));
        assert!(!replacement_started.load(Ordering::SeqCst));
        assert!(
            third.is_ok(),
            "native completion should release the worker slot"
        );
    }
}
