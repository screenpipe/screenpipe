// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Native GPU masking for Streaming screenshots. Rectangles are clipped once in source
//! pixel space and shared by both GPU backends.
use super::scene::Rect;

#[cfg(target_os = "macos")]
pub(super) mod metal;

#[cfg(feature = "screenshot-benchmark")]
pub(super) mod benchmark;

pub(crate) fn snapshot_dimensions((width, height): (u32, u32), max_width: u32) -> (u32, u32) {
    if max_width == 0 || width <= max_width {
        return (width, height);
    }
    let ratio = f64::from(max_width) / f64::from(width);
    (
        max_width,
        (f64::from(height) * ratio).round().max(1.0) as u32,
    )
}

pub(crate) fn plan(
    (width, height): (u32, u32),
    (out_width, out_height): (u32, u32),
    masks: Option<&[Rect]>,
    ignore_zero_alpha: bool,
) -> Vec<[u32; 4]> {
    let bounds = Rect {
        x: 0,
        y: 0,
        width,
        height,
    };
    let mut data = vec![
        [width, height, out_width, out_height],
        [
            0,
            u32::from(masks.is_none()),
            u32::from(ignore_zero_alpha),
            0,
        ],
    ];
    if let Some(masks) = masks {
        data.extend(masks.iter().filter_map(|rect| {
            let r = bounds.intersection(*rect)?;
            let (x, y) = (r.x as u32, r.y as u32);
            Some([x, y, x + r.width, y + r.height])
        }));
    }
    data[1][0] = (data.len() - 2) as u32;
    data
}
