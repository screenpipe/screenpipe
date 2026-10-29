// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

use super::*;
use anyhow::{anyhow, ensure};
use cidre::{api, cv, ns, sc};
use once_cell::sync::Lazy;
use std::sync::Arc;
use tokio::sync::Semaphore;

// A native call may never return. Keep its permit in the worker, including
// after timeout, so a hung WindowServer cannot accumulate blocking workers.
static CAPTURE_SLOT: Lazy<Arc<Semaphore>> = Lazy::new(|| Arc::new(Semaphore::new(1)));
const DEADLINE: Duration = Duration::from_secs(5);

pub(crate) async fn capture_filtered(
    monitor: &SafeMonitor,
    filters: &WindowFilters,
    sources: ExclusionSources,
    _fresh: bool,
) -> anyhow::Result<DynamicImage> {
    ensure!(
        api::macos_available("14.0"),
        "window-filtered screenshots require macOS 14 or newer"
    );
    let permit = tokio::time::timeout(Duration::from_secs(1), CAPTURE_SLOT.clone().acquire_owned())
        .await
        .map_err(|_| anyhow!("window-filtered capture is still busy"))??;
    let id = monitor.id();
    let filters = filters.clone();
    let runtime = tokio::runtime::Handle::current();
    let work = tokio::task::spawn_blocking(move || {
        let _permit = permit;
        cidre::objc::ar_pool(|| {
            runtime
                .block_on(capture(id, &filters, sources))
                .map_err(|e| e.to_string())
        })
        .map_err(anyhow::Error::msg)
    });
    tokio::time::timeout(DEADLINE, work)
        .await
        .map_err(|_| anyhow!("window-filtered capture timed out"))??
}

async fn capture(
    id: u32,
    filters: &WindowFilters,
    sources: ExclusionSources,
) -> anyhow::Result<DynamicImage> {
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
    let mut selected = Vec::new();
    let mut identities = Vec::new();
    for window in content.windows().iter() {
        if !window.is_on_screen() || window.window_layer() != 0 {
            continue;
        }
        let Some(app) = window.owning_app() else {
            continue;
        };
        let Some(title) = window.title() else {
            continue;
        };
        let name = app.app_name().to_string();
        let title = title.to_string();
        if window_allowed(
            filters,
            detector.as_deref(),
            &name,
            &title,
            app.process_id(),
        ) {
            identities.push((window.id(), app.process_id(), name, title));
            selected.push(window.retained());
        }
    }
    ensure!(!selected.is_empty(), "no verified allowed windows");
    let windows = ns::Array::from_slice_retained(&selected);
    let filter = sc::ContentFilter::with_display_including_windows(display, &windows);
    let mut cfg = sc::StreamCfg::new();
    let native_width = display.width() as usize;
    let native_height = display.height() as usize;
    let cap = crate::monitor::sck_capture_max_width() as usize;
    let width = if cap == 0 {
        native_width
    } else {
        native_width.min(cap)
    };
    ensure!(
        native_width > 0 && native_height > 0,
        "invalid display dimensions"
    );
    cfg.set_width(width);
    cfg.set_height((native_height * width / native_width).max(1));
    cfg.set_pixel_format(cv::PixelFormat::_32_BGRA);
    cfg.set_shows_cursor(false);
    // Match the existing captureMaxWidth contract: scale the entire display,
    // rather than cropping its right/bottom edges at smaller output sizes.
    cfg.set_scales_to_fit(true);
    if api::macos_available("15.0") {
        cfg.set_show_mouse_clicks(false);
    }
    let sample = sc::ScreenshotManager::capture_sample_buf(&filter, &cfg)
        .await
        .map_err(|e| anyhow!("window-filtered screenshot: {e:?}"))?;
    // Do not accept a frame across window reuse/title changes. A newly created
    // unrelated window is absent from the positive filter even during animation.
    let after = sc::ShareableContent::current()
        .await
        .map_err(|e| anyhow!("window revalidation: {e:?}"))?;
    let after_windows = after.windows();
    for (id, pid, name, title) in identities {
        let same = after_windows.iter().any(|w| {
            w.id() == id
                && w.is_on_screen()
                && w.title().is_some_and(|t| t.to_string() == title)
                && w.owning_app()
                    .is_some_and(|a| a.process_id() == pid && a.app_name().to_string() == name)
        });
        ensure!(same, "allowed window changed during capture");
    }
    let mut pixels = sample
        .image_buf()
        .ok_or_else(|| anyhow!("missing screenshot pixels"))?
        .retained();
    rgba(&mut pixels)
}

fn rgba(buf: &mut cv::ImageBuf) -> anyhow::Result<DynamicImage> {
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
                t.copy_from_slice(&[s[2], s[1], s[0], 255]);
            }
        }
        Ok(DynamicImage::ImageRgba8(image))
    })();
    unsafe { buf.unlock_lock_base_addr(flags) };
    result
}
