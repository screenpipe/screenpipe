// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Persistent positive-selection screenshot source. This owns no HD handles,
//! encoder, or recording cadence. Native callbacks retain one IOSurface; pixel
//! conversion remains on the existing screenshot worker, at the save cadence.

use anyhow::{anyhow, ensure, Result};
use cidre::sc::stream::{Delegate, Output};
use cidre::{arc, cm, cv, define_obj_type, dispatch, ns, objc, sc};
use once_cell::sync::Lazy;
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex,
};

static SLOTS: Lazy<Mutex<HashMap<u32, Arc<Slot>>>> = Lazy::new(|| Mutex::new(HashMap::new()));

pub(super) struct Slot {
    id: u32,
    active: AtomicBool,
    stream: Mutex<Option<Arc<NativeStream>>>,
    sequence: Arc<AtomicU64>,
    background_available: AtomicBool,
}

impl Slot {
    pub(super) fn is_active(&self) -> bool {
        self.active.load(Ordering::Acquire)
    }

    pub(super) fn report_background_availability(&self, available: bool, cause: Option<&str>) {
        if self.background_available.swap(available, Ordering::AcqRel) == available {
            return;
        }
        if available {
            tracing::info!(
                monitor_id = self.id,
                fps = frame_rate(),
                "background screenshot sampling available again"
            );
        } else {
            tracing::warn!(
                monitor_id = self.id,
                fps = frame_rate(),
                error = cause.unwrap_or("sharing-control metadata unavailable"),
                screenshot_outcome = "same_policy_snapshots",
                "background screenshot sampling unavailable; keeping on-demand recording"
            );
        }
    }
}

pub(super) fn slot(id: u32) -> Arc<Slot> {
    SLOTS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .entry(id)
        .or_insert_with(|| {
            Arc::new(Slot {
                id,
                active: AtomicBool::new(true),
                stream: Mutex::new(None),
                sequence: Arc::new(AtomicU64::new(0)),
                background_available: AtomicBool::new(true),
            })
        })
        .clone()
}

pub(super) fn suspend(slot: &Slot) {
    let removed = slot.stream.lock().unwrap_or_else(|e| e.into_inner()).take();
    if let Some(native) = removed {
        native.shared.disable();
        drop(native);
    }
}

fn close(slot: Arc<Slot>) {
    slot.active.store(false, Ordering::Release);
    let stream = slot.stream.lock().unwrap_or_else(|e| e.into_inner()).take();
    if let Some(stream) = stream {
        stream.shared.disable();
        drop(stream);
    }
}

pub(crate) fn invalidate(id: u32) {
    let removed = SLOTS.lock().unwrap_or_else(|e| e.into_inner()).remove(&id);
    if let Some(slot) = removed {
        close(slot);
    }
}

pub(super) struct RequestLease {
    id: u32,
    slot: Arc<Slot>,
    pub completed: bool,
}

impl RequestLease {
    pub fn new(id: u32, slot: Arc<Slot>) -> Self {
        Self {
            id,
            slot,
            completed: false,
        }
    }
}

impl Drop for RequestLease {
    fn drop(&mut self) {
        if self.completed {
            return;
        }
        let removed = {
            let mut slots = SLOTS.lock().unwrap_or_else(|e| e.into_inner());
            if slots
                .get(&self.id)
                .is_some_and(|slot| Arc::ptr_eq(slot, &self.slot))
            {
                slots.remove(&self.id)
            } else {
                None
            }
        };
        if let Some(slot) = removed {
            close(slot);
        }
    }
}

pub(crate) fn invalidate_all() {
    let removed = std::mem::take(&mut *SLOTS.lock().unwrap_or_else(|e| e.into_inner()));
    for (_, slot) in removed {
        close(slot);
    }
}

pub(crate) fn sequence(id: u32) -> Option<u64> {
    let slots = SLOTS.lock().ok()?;
    let slot = slots.get(&id)?;
    let stream = slot.stream.lock().ok()?;
    // A same-policy snapshot fallback has no producer to monitor. Reporting a
    // frozen zero here would repeatedly tear down otherwise valid recording.
    stream.as_ref()?;
    Some(slot.sequence.load(Ordering::Acquire))
}

pub(super) fn has_source(id: u32) -> bool {
    SLOTS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&id)
        .is_some_and(|slot| {
            slot.stream
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .is_some()
        })
}

// Called only on the serialized screenshot worker. This preview is used for
// visual-change detection; saved screenshots still reselect current policy.
pub(super) fn copy_preview(id: u32) -> Result<Option<image::DynamicImage>> {
    let slot = SLOTS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .get(&id)
        .cloned();
    let Some(slot) = slot else { return Ok(None) };
    let native = slot
        .stream
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let Some(native) = native else {
        return Ok(None);
    };
    ensure!(
        slot.active.load(Ordering::Acquire) && native.shared.enabled.load(Ordering::Acquire),
        "screenshot preview is being invalidated"
    );
    let mut frame = native
        .shared
        .state
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .frame
        .clone()
        .ok_or_else(|| anyhow!("screenshot preview has no native frame yet"))?;
    super::macos::rgba(&mut frame.0).map(Some)
}

// CoreVideo reference counting is thread safe. A retained SCK image owns an
// immutable IOSurface until released. Only the serialized screenshot worker
// locks its base address for reading; callbacks never access its bytes.
#[derive(Clone)]
struct NativeFrame(arc::R<cv::ImageBuf>);
unsafe impl Send for NativeFrame {}

#[derive(Default)]
struct State {
    frame: Option<NativeFrame>,
    observed: Option<cm::Time>,
    received_at: Option<cm::Time>,
    error: Option<String>,
}

impl State {
    fn observe(
        &mut self,
        status: Option<i64>,
        frame: Option<NativeFrame>,
        pts: cm::Time,
        received_at: cm::Time,
    ) {
        self.received_at = Some(received_at);
        match status {
            Some(value) if value == sc::FrameStatus::Complete as i64 => {
                self.frame = frame;
                self.observed = pts.is_valid().then_some(pts);
            }
            Some(value) if value == sc::FrameStatus::Idle as i64 && self.frame.is_some() => {
                self.observed = pts.is_valid().then_some(pts);
            }
            _ => {
                self.frame = None;
                self.observed = None;
            }
        }
    }

    fn at_or_after(&self, not_before: cm::Time) -> Option<(NativeFrame, cm::Time)> {
        self.observed
            .filter(|pts| {
                *pts >= not_before && self.received_at.is_some_and(|time| time >= not_before)
            })
            .and_then(|pts| self.frame.as_ref().map(|frame| (frame.clone(), pts)))
    }
}

struct Shared {
    enabled: AtomicBool,
    state: Mutex<State>,
    sequence: Arc<AtomicU64>,
}

impl Shared {
    fn disable(&self) {
        self.enabled.store(false, Ordering::Release);
        *self.state.lock().unwrap_or_else(|e| e.into_inner()) = State::default();
    }
}

define_obj_type!(
    Receiver + sc::stream::OutputImpl + sc::stream::DelegateImpl,
    Arc<Shared>,
    SCREENSHOT_RECEIVER
);
impl sc::stream::Output for Receiver {}
impl sc::stream::Delegate for Receiver {}
// The output contains only synchronized Rust state; delivery uses one serial
// dispatch queue. No native objects in its ivar are mutated across threads.
unsafe impl Send for Receiver {}
unsafe impl Sync for Receiver {}

#[objc::add_methods]
impl sc::stream::DelegateImpl for Receiver {
    extern "C" fn impl_stream_did_stop_with_err(
        &mut self,
        _cmd: Option<&objc::Sel>,
        _stream: &sc::Stream,
        error: &ns::Error,
    ) {
        let shared = self.inner();
        let cause = format!("{error:?}");
        tracing::warn!(error = %cause, screenshot_outcome = "unavailable", "native screenshot stream stopped");
        let mut state = shared.state.lock().unwrap_or_else(|e| e.into_inner());
        state.frame = None;
        state.observed = None;
        state.error = Some(cause);
        drop(state);
    }
}

#[objc::add_methods]
impl sc::stream::OutputImpl for Receiver {
    extern "C" fn impl_stream_did_output_sample_buf(
        &mut self,
        _cmd: Option<&objc::Sel>,
        _stream: &sc::Stream,
        sample: &mut cm::SampleBuf,
        kind: sc::OutputType,
    ) {
        if kind != sc::OutputType::Screen {
            return;
        }
        let shared = self.inner();
        if !shared.enabled.load(Ordering::Acquire) {
            return;
        }
        let received_at = cm::Clock::host_time_clock().time();
        let status = sample
            .attaches(false)
            .and_then(|a| a.iter().next())
            .and_then(|a| a.get(sc::FrameInfo::status().as_cf()))
            .and_then(|value| value.try_as_number())
            .and_then(|n| n.to_i64());
        // Never block the OS callback or convert/copy pixels here. A busy
        // reader may miss a preview update; accepted screenshots are saved by
        // the existing writer, independently of this replaceable native latch.
        let Ok(mut state) = shared.state.try_lock() else {
            return;
        };
        if !shared.enabled.load(Ordering::Acquire) {
            return;
        }
        // Preserve SCK's timestamp even for idle callbacks: it may repeat an
        // older image time and cannot be replaced with callback-arrival time.
        let frame = (status == Some(sc::FrameStatus::Complete as i64))
            .then(|| sample.image_buf().map(|b| NativeFrame(b.retained())))
            .flatten();
        state.observe(status, frame, sample.pts(), received_at);
        shared.sequence.fetch_add(1, Ordering::Release);
        drop(state);
    }
}

#[derive(PartialEq)]
pub(super) struct Key {
    pub width: usize,
    pub height: usize,
    pub menu_bar: bool,
    pub windows: Vec<(u32, i32)>,
    pub fps: u32,
}

struct NativeStream {
    key: Key,
    stream: arc::R<sc::Stream>,
    output: arc::R<Receiver>,
    queue: arc::R<dispatch::Queue>,
    shared: Arc<Shared>,
}

impl Drop for NativeStream {
    fn drop(&mut self) {
        self.shared.disable();
        // The receiver is both output and delegate. Retain it through native
        // stop completion, then fence the output queue before releasing it.
        // No thread waits for stop and no detached stop worker accumulates.
        if let Err(error) = self
            .stream
            .remove_stream_output(self.output.as_ref(), sc::OutputType::Screen)
        {
            tracing::warn!(error = ?error, "screenshot stream output removal failed");
        }
        let mut output = Some(self.output.retained());
        let queue = self.queue.retained();
        self.stream.stop_with_ch(move |error| {
            if let Some(error) = error {
                tracing::warn!(error = ?error, "screenshot stream stop failed");
            }
            if let Some(output) = output.take() {
                queue.async_once(move || drop(output));
            }
        });
    }
}

pub(super) async fn frame(
    slot: &Arc<Slot>,
    filter: &sc::ContentFilter,
    key: Key,
    not_before: cm::Time,
) -> Result<Option<(arc::R<cv::ImageBuf>, chrono::DateTime<chrono::Utc>)>> {
    ensure!(
        slot.active.load(Ordering::Acquire),
        "screenshot stream invalidated; next capture must reopen it"
    );
    // A late callback for a previous policy must never satisfy this request.
    // Compare native PTS, not callback-arrival time (queues can deliver late).
    let existing = slot
        .stream
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    let native = if let Some(native) = existing.filter(|s| s.key == key) {
        native
    } else {
        let removed = slot.stream.lock().unwrap_or_else(|e| e.into_inner()).take();
        drop(removed);
        // Visual probes previously owned a second 2fps producer. They read
        // this source while it is active, so retire that legacy handle here.
        // HD owns a separate stream and is unaffected by this API.
        sck_rs::invalidate_monitor_stream(slot.id);
        let shared = Arc::new(Shared {
            enabled: AtomicBool::new(true),
            state: Mutex::new(State::default()),
            sequence: slot.sequence.clone(),
        });
        let output = Receiver::with(shared.clone());
        let queue = dispatch::Queue::serial_with_ar_pool();
        let mut cfg = sc::StreamCfg::new();
        cfg.set_width(key.width);
        cfg.set_height(key.height);
        cfg.set_pixel_format(cv::PixelFormat::_32_BGRA);
        cfg.set_shows_cursor(false);
        cfg.set_scales_to_fit(true);
        cfg.set_minimum_frame_interval(cm::Time::new(1, native_fps(&key)?));
        if cidre::api::macos_available("15.0") {
            cfg.set_show_mouse_clicks(false);
        }
        let stream = sc::Stream::with_delegate(filter, &cfg, output.as_ref());
        let native = Arc::new(NativeStream {
            key,
            stream,
            output,
            queue,
            shared,
        });
        native
            .stream
            .add_stream_output(
                native.output.as_ref(),
                sc::OutputType::Screen,
                Some(&native.queue),
            )
            .map_err(|e| anyhow!("screenshot stream add output: {e:?}"))?;
        native
            .stream
            .start()
            .await
            .map_err(|e| anyhow!("screenshot stream start: {e:?}"))?;
        {
            let mut entry = slot.stream.lock().unwrap_or_else(|e| e.into_inner());
            ensure!(
                slot.active.load(Ordering::Acquire),
                "screenshot stream invalidated during start; next capture must reopen it"
            );
            *entry = Some(native.clone());
        }
        tracing::info!(
            width = native.key.width,
            height = native.key.height,
            fps = native.key.fps,
            legacy_preview_active = sck_rs::monitor_frame_seq(slot.id).is_some(),
            "persistent positive-selection screenshot stream started"
        );
        native
    };
    ensure!(
        slot.active.load(Ordering::Acquire) && native.shared.enabled.load(Ordering::Acquire),
        "screenshot stream invalidated; next capture must reopen it"
    );
    let observed = {
        let state = native
            .shared
            .state
            .lock()
            .unwrap_or_else(|e| e.into_inner());
        if let Some(error) = &state.error {
            return Err(anyhow!("screenshot stream stopped: {error}"));
        }
        state.at_or_after(not_before)
    };
    // This is a cache lookup, never capture admission paced by background fps.
    // If no frame arrived after the current policy observation, the caller
    // requests a snapshot with the identical positive filter. Waiting for the
    // next 2fps update delayed valid event screenshots by ~500ms in the VM.
    let Some((frame, pts)) = observed else {
        return Ok(None);
    };
    let Some(captured_at) =
        wall_timestamp(pts, cm::Clock::host_time_clock().time(), chrono::Utc::now())
    else {
        return Ok(None);
    };
    Ok(Some((frame.0, captured_at)))
}

/// SCK reports presentation time, which can be slightly ahead of its callback
/// (observed in the VM). Preserve that signed offset instead of discarding a
/// valid frame or relabelling its time. Invalid/unrepresentable metadata lets
/// the caller request fresh pixels without rejecting otherwise valid pixels.
pub(super) fn wall_timestamp(
    pts: cm::Time,
    host_now: cm::Time,
    utc_now: chrono::DateTime<chrono::Utc>,
) -> Option<chrono::DateTime<chrono::Utc>> {
    if !pts.is_valid() {
        return None;
    }
    let age = host_now.as_secs() - pts.as_secs();
    if !age.is_finite() {
        return None;
    }
    let offset = std::time::Duration::try_from_secs_f64(age.abs()).ok()?;
    let offset = chrono::Duration::from_std(offset).ok()?;
    if age >= 0.0 {
        utc_now.checked_sub_signed(offset)
    } else {
        utc_now.checked_add_signed(offset)
    }
}

fn native_fps(key: &Key) -> Result<i32> {
    let fps = i32::try_from(key.fps)
        .map_err(|_| anyhow!("screenshot rate exceeds native CMTime timescale"))?;
    ensure!(fps > 0, "screenshot rate must be positive");
    Ok(fps)
}

pub(super) fn frame_rate() -> u32 {
    crate::screenshot_rate::current()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn snapshot_only_admission_does_not_report_a_frozen_producer() {
        let id = 4_000_000_004;
        let admission = slot(id);
        admission.sequence.store(12, Ordering::Release);
        assert_eq!(sequence(id), None);
        suspend(&admission);
        assert!(admission.is_active());
        assert_eq!(sequence(id), None);
        invalidate(id);
    }

    fn pixels() -> NativeFrame {
        NativeFrame(cv::PixelBuf::new(2, 2, cv::PixelFormat::_32_BGRA, None).unwrap())
    }

    #[test]
    fn a_future_presentation_time_does_not_authorize_an_already_cached_frame() {
        let mut state = State::default();
        state.observe(
            Some(sc::FrameStatus::Complete as i64),
            Some(pixels()),
            cm::Time::new(12, 1),
            cm::Time::new(10, 1),
        );
        assert!(state.at_or_after(cm::Time::new(11, 1)).is_none());
    }

    #[test]
    fn late_native_frame_cannot_cross_the_current_policy_boundary() {
        let mut state = State::default();
        state.observe(
            Some(sc::FrameStatus::Complete as i64),
            Some(pixels()),
            cm::Time::new(10, 1),
            cm::Time::new(20, 1),
        );
        // Callback arrival could be arbitrarily late; source PTS is what
        // decides whether this image belongs to the new privacy observation.
        assert!(state.at_or_after(cm::Time::new(11, 1)).is_none());
        state.observe(
            Some(sc::FrameStatus::Complete as i64),
            Some(pixels()),
            cm::Time::new(12, 1),
            cm::Time::new(12, 1),
        );
        assert!(state.at_or_after(cm::Time::new(11, 1)).is_some());
    }

    #[test]
    fn idle_requires_known_pixels_and_suspension_invalidates_them() {
        let mut state = State::default();
        state.observe(
            Some(sc::FrameStatus::Idle as i64),
            None,
            cm::Time::new(10, 1),
            cm::Time::new(10, 1),
        );
        assert!(state.at_or_after(cm::Time::new(1, 1)).is_none());
        state.observe(
            Some(sc::FrameStatus::Complete as i64),
            Some(pixels()),
            cm::Time::new(10, 1),
            cm::Time::new(10, 1),
        );
        state.observe(
            Some(sc::FrameStatus::Idle as i64),
            None,
            cm::Time::new(12, 1),
            cm::Time::new(12, 1),
        );
        assert!(state.at_or_after(cm::Time::new(11, 1)).is_some());
        for status in [
            None,
            Some(sc::FrameStatus::Blank as i64),
            Some(sc::FrameStatus::Suspended as i64),
            Some(sc::FrameStatus::Stopped as i64),
        ] {
            state.observe(status, None, cm::Time::new(13, 1), cm::Time::new(13, 1));
            state.observe(
                Some(sc::FrameStatus::Idle as i64),
                None,
                cm::Time::new(14, 1),
                cm::Time::new(14, 1),
            );
            assert!(state.at_or_after(cm::Time::new(11, 1)).is_none());
        }
    }

    #[test]
    fn idle_does_not_relabel_an_old_frame_with_a_new_observation_time() {
        let mut state = State::default();
        state.observe(
            Some(sc::FrameStatus::Complete as i64),
            Some(pixels()),
            cm::Time::new(10, 1),
            cm::Time::new(10, 1),
        );
        state.observe(
            Some(sc::FrameStatus::Idle as i64),
            None,
            cm::Time::new(10, 1),
            cm::Time::new(10, 1),
        );
        assert!(state.frame.is_some());
        assert!(state.at_or_after(cm::Time::new(11, 1)).is_none());
    }

    #[test]
    fn presentation_time_preserves_past_present_and_future_offsets() {
        let now = chrono::Utc::now();
        let host = cm::Time::new(10_000, 1000);
        for milliseconds in [-5, 0, 5] {
            assert_eq!(
                wall_timestamp(cm::Time::new(10_000 + milliseconds, 1000), host, now),
                Some(now + chrono::Duration::milliseconds(milliseconds)),
            );
        }
    }

    #[test]
    fn cancelling_an_old_request_cannot_close_a_replacement_stream() {
        let id = 4_000_000_001;
        let first = slot(id);
        let lease = RequestLease::new(id, first.clone());
        invalidate(id);
        let replacement = slot(id);
        drop(lease);
        assert!(!first.active.load(Ordering::Acquire));
        assert!(replacement.active.load(Ordering::Acquire));
        invalidate(id);
    }

    #[test]
    fn monitor_shutdown_does_not_invalidate_another_monitor() {
        let first = slot(4_000_000_002);
        let second = slot(4_000_000_003);
        invalidate(4_000_000_002);
        assert!(!first.active.load(Ordering::Acquire));
        assert!(second.active.load(Ordering::Acquire));
        invalidate(4_000_000_003);
    }

    #[test]
    fn invalid_rate_preserves_the_admitted_stream_and_current_preference() {
        let id = 4_000_000_004;
        let live = slot(id);
        let previous = frame_rate();
        for invalid in [0, i32::MAX as u32 + 1] {
            assert!(crate::screenshot_rate::set(invalid).is_err());
            assert_eq!(frame_rate(), previous);
            assert!(live.active.load(Ordering::Acquire));
            assert!(Arc::ptr_eq(&slot(id), &live));
        }
        invalidate(id);
    }
}
