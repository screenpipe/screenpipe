// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Persistent positive-selection screenshot source. This owns no HD handles,
//! encoder, or recording cadence. Native callbacks retain one IOSurface; pixel
//! conversion remains on the existing screenshot worker, at the save cadence.

use anyhow::{anyhow, ensure, Result};
use cidre::{arc, cm, cv, define_obj_type, dispatch, ns, objc, sc};
use once_cell::sync::Lazy;
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex,
};
use tokio::sync::Notify;

static SLOTS: Lazy<Mutex<HashMap<u32, Arc<Slot>>>> = Lazy::new(|| Mutex::new(HashMap::new()));

pub(super) struct Slot {
    active: AtomicBool,
    stream: Mutex<Option<Arc<NativeStream>>>,
    sequence: Arc<AtomicU64>,
}

pub(super) fn slot(id: u32) -> Arc<Slot> {
    SLOTS
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .entry(id)
        .or_insert_with(|| {
            Arc::new(Slot {
                active: AtomicBool::new(true),
                stream: Mutex::new(None),
                sequence: Arc::new(AtomicU64::new(0)),
            })
        })
        .clone()
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
    SLOTS
        .lock()
        .ok()?
        .get(&id)
        .map(|slot| slot.sequence.load(Ordering::Acquire))
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
    error: Option<String>,
}

impl State {
    fn observe(&mut self, status: Option<i64>, frame: Option<NativeFrame>, pts: cm::Time) {
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
            .filter(|pts| *pts >= not_before)
            .and_then(|pts| self.frame.as_ref().map(|frame| (frame.clone(), pts)))
    }
}

struct Shared {
    enabled: AtomicBool,
    state: Mutex<State>,
    changed: Notify,
    sequence: Arc<AtomicU64>,
}

impl Shared {
    fn disable(&self) {
        self.enabled.store(false, Ordering::Release);
        *self.state.lock().unwrap_or_else(|e| e.into_inner()) = State::default();
        self.changed.notify_waiters();
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
        shared.changed.notify_waiters();
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
        // Idle confirms unchanged pixels at this native observation time,
        // even when SCK supplies no new IOSurface.
        let frame = (status == Some(sc::FrameStatus::Complete as i64))
            .then(|| sample.image_buf().map(|b| NativeFrame(b.retained())))
            .flatten();
        state.observe(status, frame, sample.pts());
        shared.sequence.fetch_add(1, Ordering::Release);
        drop(state);
        shared.changed.notify_waiters();
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
        // Remove the output before releasing it. The serial-queue fence owns
        // it until already-enqueued callbacks finish; no thread waits for an
        // OS stop completion and no detached stop worker accumulates.
        if let Err(error) = self
            .stream
            .remove_stream_output(self.output.as_ref(), sc::OutputType::Screen)
        {
            tracing::warn!(error = ?error, "screenshot stream output removal failed");
        }
        let output = self.output.retained();
        self.queue.async_once(move || drop(output));
        self.stream.stop_with_ch(|error| {
            if let Some(error) = error {
                tracing::warn!(error = ?error, "screenshot stream stop failed");
            }
        });
    }
}

pub(super) async fn frame(
    slot: &Arc<Slot>,
    filter: &sc::ContentFilter,
    key: Key,
) -> Result<(arc::R<cv::ImageBuf>, chrono::DateTime<chrono::Utc>)> {
    ensure!(
        slot.active.load(Ordering::Acquire),
        "screenshot stream invalidated; next capture must reopen it"
    );
    // A late callback for a previous policy must never satisfy this request.
    // Compare native PTS, not callback-arrival time (queues can deliver late).
    let not_before = cm::Clock::host_time_clock().time();
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
        let shared = Arc::new(Shared {
            enabled: AtomicBool::new(true),
            state: Mutex::new(State::default()),
            changed: Notify::new(),
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
            "persistent positive-selection screenshot stream started"
        );
        native
    };
    loop {
        let changed = native.shared.changed.notified();
        tokio::pin!(changed);
        changed.as_mut().enable();
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
        if let Some((frame, pts)) = observed {
            let age = cm::Clock::host_time_clock().time().as_secs() - pts.as_secs();
            ensure!(
                age.is_finite() && age >= 0.0,
                "invalid native screenshot timestamp"
            );
            let captured_at = chrono::Utc::now()
                - chrono::Duration::from_std(std::time::Duration::from_secs_f64(age))?;
            return Ok((frame.0, captured_at));
        }
        changed.await;
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

    fn pixels() -> NativeFrame {
        NativeFrame(cv::PixelBuf::new(2, 2, cv::PixelFormat::_32_BGRA, None).unwrap())
    }

    #[test]
    fn late_native_frame_cannot_cross_the_current_policy_boundary() {
        let mut state = State::default();
        state.observe(
            Some(sc::FrameStatus::Complete as i64),
            Some(pixels()),
            cm::Time::new(10, 1),
        );
        // Callback arrival could be arbitrarily late; source PTS is what
        // decides whether this image belongs to the new privacy observation.
        assert!(state.at_or_after(cm::Time::new(11, 1)).is_none());
        state.observe(
            Some(sc::FrameStatus::Complete as i64),
            Some(pixels()),
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
        );
        assert!(state.at_or_after(cm::Time::new(1, 1)).is_none());
        state.observe(
            Some(sc::FrameStatus::Complete as i64),
            Some(pixels()),
            cm::Time::new(10, 1),
        );
        state.observe(
            Some(sc::FrameStatus::Idle as i64),
            None,
            cm::Time::new(12, 1),
        );
        assert!(state.at_or_after(cm::Time::new(11, 1)).is_some());
        for status in [
            None,
            Some(sc::FrameStatus::Blank as i64),
            Some(sc::FrameStatus::Suspended as i64),
            Some(sc::FrameStatus::Stopped as i64),
        ] {
            state.observe(status, None, cm::Time::new(13, 1));
            state.observe(
                Some(sc::FrameStatus::Idle as i64),
                None,
                cm::Time::new(14, 1),
            );
            assert!(state.at_or_after(cm::Time::new(11, 1)).is_none());
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
