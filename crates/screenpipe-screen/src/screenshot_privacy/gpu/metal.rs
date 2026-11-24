// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

use super::super::scene::Rect;
use anyhow::{anyhow, ensure, Context, Result};
use cidre::{arc, cv, mtl, ns};
use image::{DynamicImage, RgbaImage};

const SOURCE: &str = concat!(
    "#include <metal_stdlib>\nusing namespace metal;\n",
    "#define INPUTS texture2d<float, access::read> source, const device uint4* plan\n",
    "#define SOURCE_TEXEL(x,y) source.read(uint2(x,y))\n",
    "#define MASK_INPUTS const device uint4* plan\n",
    "#define MASK_ARG plan\n",
    include_str!("triangle.inc"),
    r#"
kernel void mask_resize(texture2d<float, access::read> source [[texture(0)]],
                        const device uint4* plan [[buffer(0)]], device uchar4* out [[buffer(1)]],
                        uint2 p [[thread_position_in_grid]]) {
    if (any(p >= plan[0].zw)) return;
    out[p.y * plan[0].z + p.x] = uchar4(floor(clamp(pixel(p, source, plan), 0.0, 1.0) * 255.0 + 0.5));
}
"#,
);

pub(super) struct Metal {
    device: arc::R<mtl::Device>,
    queue: arc::R<mtl::CmdQueue>,
    cache: arc::R<cv::MetalTextureCache>,
    pipeline: arc::R<mtl::ComputePipelineState>,
    outputs: [Option<arc::R<mtl::Buf>>; 2],
}

impl Metal {
    pub(super) fn new() -> Result<Self> {
        let device = mtl::Device::sys_default().context("no default Metal device")?;
        let queue = device
            .new_cmd_queue()
            .context("create Metal command queue")?;
        let cache = cv::MetalTextureCache::create(None, &device, None)
            .map_err(|e| anyhow!("create Core Video Metal cache: {e:?}"))?;
        let library = device
            .new_lib_with_src_blocking(&ns::String::with_str(SOURCE), None)
            .map_err(|e| anyhow!("compile Metal screenshot shader: {e:?}"))?;
        let kernel = library
            .new_fn(&ns::String::with_str("mask_resize"))
            .context("find Metal screenshot kernel")?;
        let pipeline = device
            .new_compute_ps_with_fn(&kernel)
            .map_err(|e| anyhow!("create Metal screenshot pipeline: {e:?}"))?;
        Ok(Self {
            device,
            queue,
            cache,
            pipeline,
            outputs: [None, None],
        })
    }

    #[cfg(feature = "screenshot-benchmark")]
    pub(super) fn adapter(&self) -> String {
        self.device.name().to_string()
    }

    pub(super) fn render(
        &mut self,
        pixels: &cv::ImageBuf,
        masks: Option<&[Rect]>,
        output: (u32, u32),
        slot: usize,
    ) -> Result<DynamicImage> {
        ensure!(
            pixels.plane_count() == 0 && pixels.pixel_format() == cv::PixelFormat::_32_BGRA,
            "unexpected Metal screenshot pixel format"
        );
        let dims = (pixels.width() as u32, pixels.height() as u32);
        let params = super::plan(dims, output, masks, true);
        let bytes = std::mem::size_of_val(params.as_slice());
        let plan = self
            .device
            .new_buf_with_bytes(
                params.as_ptr().cast(),
                bytes,
                mtl::ResOpts::STORAGE_MODE_SHARED,
            )
            .context("allocate Metal mask plan")?;
        let source = self
            .cache
            .texture(
                pixels,
                None,
                mtl::PixelFormat::Bgra8UNorm,
                pixels.width(),
                pixels.height(),
                0,
            )
            .map_err(|e| anyhow!("wrap native screenshot in Metal texture: {e:?}"))?;
        let source_texture = source
            .texture()
            .context("missing native Metal screenshot texture")?;
        let (width, height) = (output.0 as usize, output.1 as usize);
        let len = width * height * 4;
        if !self.outputs[slot].as_ref().is_some_and(|b| b.len() == len) {
            self.outputs[slot] = Some(
                self.device
                    .new_buf(len, mtl::ResOpts::STORAGE_MODE_SHARED)
                    .context("allocate Metal screenshot output")?,
            );
        }
        let destination = self.outputs[slot].as_ref().unwrap();
        let command = self
            .queue
            .new_cmd_buf()
            .context("create Metal screenshot command")?;
        let mut encoder = command
            .new_compute_cmd_enc()
            .context("create Metal screenshot encoder")?;
        encoder.set_compute_ps(&self.pipeline);
        encoder.set_texture_at(Some(source_texture), 0);
        encoder.set_buf_at(Some(destination), 0, 1);
        encoder.set_buf_at(Some(&plan), 0, 0);
        encoder.dispatch_threadgroups(
            mtl::Size::_2d(width.div_ceil(8), height.div_ceil(8)),
            mtl::Size::_2d(8, 8),
        );
        unsafe { encoder.end_encoding() };
        command.commit();
        command.wait_until_completed();
        ensure!(
            command.status() == mtl::CmdBufStatus::Completed,
            "Metal screenshot dispatch failed: {:?}",
            command.error()
        );
        // Keep the Core Video wrapper alive until GPU execution finishes.
        let bytes = unsafe { std::slice::from_raw_parts(destination.contents(), len) };
        let rgba = RgbaImage::from_raw(output.0, output.1, bytes.to_vec())
            .context("invalid Metal screenshot readback")?;
        Ok(DynamicImage::ImageRgba8(rgba))
    }
}

pub(in crate::screenshot_privacy) fn render(
    pixels: &cv::ImageBuf,
    masks: &[Rect],
    resize: u32,
) -> Result<(DynamicImage, Option<DynamicImage>)> {
    thread_local! {
        static METAL: std::cell::RefCell<Option<Metal>> = const { std::cell::RefCell::new(None) };
    }
    objc_pool(|| {
        METAL.with_borrow_mut(|renderer| {
            if renderer.is_none() {
                *renderer = Some(Metal::new()?);
            }
            let dims = (pixels.width() as u32, pixels.height() as u32);
            let out = super::snapshot_dimensions(dims, resize);
            let renderer = renderer.as_mut().unwrap();
            let full = renderer.render(pixels, Some(masks), dims, 0)?;
            let snapshot = (out != dims)
                .then(|| renderer.render(pixels, Some(masks), out, 1))
                .transpose()?;
            Ok((full, snapshot))
        })
    })
}

pub(super) fn objc_pool<T>(run: impl FnOnce() -> T) -> T {
    let _pool = cidre::objc::AutoreleasePoolPage::push();
    run()
}
