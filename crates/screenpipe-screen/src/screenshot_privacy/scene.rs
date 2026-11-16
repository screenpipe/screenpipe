// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Pixel operations for screenshot redaction and native window composition.
//! Rectangles use output pixels. macOS redacts a captured display here before
//! returning it; other backends compose positively selected window surfaces.
use image::{Rgba, RgbaImage};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) struct Rect {
    pub x: i64,
    pub y: i64,
    pub width: u32,
    pub height: u32,
}

impl Rect {
    pub fn intersection(self, other: Self) -> Option<Self> {
        let x = self.x.max(other.x);
        let y = self.y.max(other.y);
        let right = (self.x + i64::from(self.width)).min(other.x + i64::from(other.width));
        let bottom = (self.y + i64::from(self.height)).min(other.y + i64::from(other.height));
        (right > x && bottom > y).then_some(Self {
            x,
            y,
            width: (right - x).max(0) as u32,
            height: (bottom - y).max(0) as u32,
        })
    }

    pub fn intersects(self, other: Self) -> bool {
        self.intersection(other).is_some()
    }
}

pub(super) fn paint_black(image: &mut RgbaImage, rect: Rect) {
    let Some(rect) = rect.intersection(Rect {
        x: 0,
        y: 0,
        width: image.width(),
        height: image.height(),
    }) else {
        return;
    };
    for y in rect.y as u32..rect.y as u32 + rect.height {
        for x in rect.x as u32..rect.x as u32 + rect.width {
            image.put_pixel(x, y, Rgba([0, 0, 0, 255]));
        }
    }
}

/// Native alpha coverage stays in its original buffer. Expanding fragmented
/// shell alpha into rectangles can create per-pixel region bookkeeping.
#[cfg(any(target_os = "macos", test))]
pub(super) enum Redaction {
    Rect(Rect),
    Coverage {
        bounds: Rect,
        mask: RgbaImage,
        x: i64,
        y: i64,
    },
}
#[cfg(any(target_os = "macos", test))]
impl Redaction {
    fn bounds(&self) -> Rect {
        match self {
            Self::Rect(rect) => *rect,
            Self::Coverage { bounds, .. } => *bounds,
        }
    }
    pub fn intersects(&self, rect: Rect) -> bool {
        self.bounds().intersects(rect)
    }
    fn covers(&self, dx: i64, dy: i64) -> bool {
        let r = self.bounds();
        if dx < r.x || dy < r.y || dx >= r.x + i64::from(r.width) || dy >= r.y + i64::from(r.height)
        {
            return false;
        }
        match self {
            Self::Rect(_) => true,
            Self::Coverage { mask, x, y, .. } => {
                mask.get_pixel((dx - x) as u32, (dy - y) as u32)[3] > 0
            }
        }
    }
}

/// Mask only native alpha, never excluded RGB. The returned bounds exclude the
/// display-sized transparent shell area; holes remain in the original mask.
#[cfg(any(target_os = "macos", test))]
pub(super) fn paint_black_coverage(
    canvas: &mut RgbaImage,
    mask: &RgbaImage,
    x: i64,
    y: i64,
) -> Option<Rect> {
    let (mut left, mut top, mut right, mut bottom) = (canvas.width(), canvas.height(), 0, 0);
    for (sx, sy, pixel) in mask.enumerate_pixels() {
        let dx = x + i64::from(sx);
        let dy = y + i64::from(sy);
        if pixel[3] > 0
            && dx >= 0
            && dy >= 0
            && dx < i64::from(canvas.width())
            && dy < i64::from(canvas.height())
        {
            let (dx, dy) = (dx as u32, dy as u32);
            canvas.put_pixel(dx, dy, Rgba([0, 0, 0, 255]));
            left = left.min(dx);
            top = top.min(dy);
            right = right.max(dx + 1);
            bottom = bottom.max(dy + 1);
        }
    }
    (right > left && bottom > top).then(|| Rect {
        x: i64::from(left),
        y: i64::from(top),
        width: right - left,
        height: bottom - top,
    })
}

/// Restore once across the union of opaque rectangles and native shell alpha.
/// In particular, never blend foreground again through a transparent mask hole.
#[cfg(any(target_os = "macos", test))]
pub(super) fn overlay_redacted(
    canvas: &mut RgbaImage,
    source: &RgbaImage,
    x: i64,
    y: i64,
    redactions: &[Redaction],
) {
    let source_rect = Rect {
        x,
        y,
        width: source.width(),
        height: source.height(),
    };
    let mut clip: Option<Rect> = None;
    for redaction in redactions {
        if let Some(rect) = redaction.bounds().intersection(source_rect) {
            clip = Some(match clip {
                None => rect,
                Some(old) => {
                    let x = old.x.min(rect.x);
                    let y = old.y.min(rect.y);
                    Rect {
                        x,
                        y,
                        width: ((old.x + i64::from(old.width)).max(rect.x + i64::from(rect.width))
                            - x) as u32,
                        height: ((old.y + i64::from(old.height))
                            .max(rect.y + i64::from(rect.height))
                            - y) as u32,
                    }
                }
            });
        }
    }
    if let Some(clip) = clip {
        overlay_where(canvas, source, x, y, Some(clip), |dx, dy| {
            redactions.iter().any(|r| r.covers(dx, dy))
        });
    }
}

/// Blend premultiplied native RGBA onto an opaque canvas. An optional region
/// limits restoration to a redacted area, leaving other foreground pixels alone.
pub(super) fn overlay_premultiplied(
    canvas: &mut RgbaImage,
    source: &RgbaImage,
    x: i64,
    y: i64,
    region: Option<Rect>,
) {
    overlay_where(canvas, source, x, y, region, |_, _| true);
}

fn overlay_where<F: Fn(i64, i64) -> bool>(
    canvas: &mut RgbaImage,
    source: &RgbaImage,
    x: i64,
    y: i64,
    region: Option<Rect>,
    covers: F,
) {
    let source_rect = Rect {
        x,
        y,
        width: source.width(),
        height: source.height(),
    };
    let bounds = Rect {
        x: 0,
        y: 0,
        width: canvas.width(),
        height: canvas.height(),
    };
    let Some(mut clip) = source_rect.intersection(bounds) else {
        return;
    };
    if let Some(region) = region {
        let Some(intersection) = clip.intersection(region) else {
            return;
        };
        clip = intersection;
    }
    for dy in clip.y..clip.y + i64::from(clip.height) {
        for dx in clip.x..clip.x + i64::from(clip.width) {
            if !covers(dx, dy) {
                continue;
            }
            let s = source.get_pixel((dx - x) as u32, (dy - y) as u32);
            if s[3] == 0 {
                continue;
            } // unused RGB bytes are not content
            let d = canvas.get_pixel_mut(dx as u32, dy as u32);
            let inverse = 255 - u16::from(s[3]);
            for c in 0..3 {
                d[c] = (u16::from(s[c]) + (u16::from(d[c]) * inverse + 127) / 255).min(255) as u8;
            }
            d[3] = 255;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn rect(x: i64, y: i64, w: u32, h: u32) -> Rect {
        Rect {
            x,
            y,
            width: w,
            height: h,
        }
    }
    #[test]
    fn excluded_shell_coverage_preserves_transparent_desktop_area() {
        let mut canvas = RgbaImage::from_pixel(3, 1, Rgba([0, 255, 255, 255]));
        let mask =
            RgbaImage::from_raw(3, 1, vec![255, 0, 255, 0, 255, 0, 255, 1, 255, 0, 255, 255])
                .unwrap();
        assert_eq!(
            paint_black_coverage(&mut canvas, &mask, 0, 0),
            Some(rect(1, 0, 2, 1))
        );
        assert_eq!(canvas.get_pixel(0, 0).0, [0, 255, 255, 255]);
        assert_eq!(canvas.get_pixel(1, 0).0, [0, 0, 0, 255]);
        assert_eq!(canvas.get_pixel(2, 0).0, [0, 0, 0, 255]);
    }
    #[test]
    fn overlapping_exclusions_restore_transparency_once_per_pixel() {
        let regions = [
            Redaction::Rect(rect(0, 0, 3, 3)),
            Redaction::Rect(rect(1, 1, 3, 3)),
            Redaction::Rect(rect(0, 0, 3, 3)),
        ];
        let mut canvas = RgbaImage::from_pixel(4, 4, Rgba([0, 0, 0, 255]));
        let source = RgbaImage::from_pixel(4, 4, Rgba([64, 0, 0, 128]));
        overlay_redacted(&mut canvas, &source, 0, 0, &regions);
        assert_eq!(canvas.get_pixel(1, 1).0, [64, 0, 0, 255]);
        assert_eq!(canvas.get_pixel(3, 0).0, [0, 0, 0, 255]);
        assert_eq!(canvas.pixels().filter(|p| p[0] == 64).count(), 14);
    }

    #[test]
    fn fragmented_shell_coverage_preserves_holes_and_clips_overlaps() {
        let mut canvas = RgbaImage::from_pixel(8, 8, Rgba([0, 100, 0, 255]));
        let mut mask = RgbaImage::from_pixel(8, 8, Rgba([255, 0, 255, 0]));
        for y in 0..8 {
            for x in 0..8 {
                if (x + y) % 2 == 0 {
                    mask.put_pixel(x, y, Rgba([255, 0, 255, 1]));
                }
            }
        }
        let bounds = paint_black_coverage(&mut canvas, &mask, -1, 0).unwrap();
        let regions = [
            Redaction::Coverage {
                bounds,
                mask,
                x: -1,
                y: 0,
            },
            Redaction::Rect(rect(0, 0, 2, 1)),
        ];
        paint_black(&mut canvas, rect(0, 0, 2, 1));
        let source = RgbaImage::from_pixel(8, 8, Rgba([64, 0, 0, 128]));
        overlay_redacted(&mut canvas, &source, 0, 0, &regions);
        for y in 0..8 {
            for x in 0..8 {
                let covered = x < 2 && y == 0 || x < 7 && (x + 1 + y) % 2 == 0;
                assert_eq!(
                    canvas.get_pixel(x, y).0,
                    if covered {
                        [64, 0, 0, 255]
                    } else {
                        [0, 100, 0, 255]
                    }
                );
            }
        }
    }

    #[test]
    fn transparent_shell_does_not_restore_unrelated_foreground() {
        let mut canvas = RgbaImage::from_pixel(8, 6, Rgba([0, 100, 0, 255]));
        let mut mask = RgbaImage::from_pixel(8, 6, Rgba([255, 0, 255, 0]));
        assert!(paint_black_coverage(&mut canvas, &mask, 0, 0).is_none());
        for y in 4..6 {
            for x in 2..6 {
                mask.put_pixel(x, y, Rgba([255, 0, 255, 128]));
            }
        }
        let bounds = paint_black_coverage(&mut canvas, &mask, 0, 0).unwrap();
        assert_eq!(bounds, rect(2, 4, 4, 2));
        let region = Redaction::Coverage {
            bounds,
            mask,
            x: 0,
            y: 0,
        };
        assert!(!region.intersects(rect(0, 0, 8, 4)));
        let foreground = RgbaImage::from_pixel(8, 6, Rgba([64, 0, 0, 128]));
        overlay_redacted(&mut canvas, &foreground, 0, 0, &[region]);
        assert_eq!(canvas.get_pixel(0, 0).0, [0, 100, 0, 255]);
        assert_eq!(canvas.get_pixel(3, 5).0, [64, 0, 0, 255]);
    }

    #[test]
    fn excluded_middle_layer_keeps_allowed_foreground_and_hides_background() {
        let mut canvas = RgbaImage::from_pixel(12, 8, Rgba([0, 200, 0, 255]));
        paint_black(&mut canvas, rect(3, 2, 6, 4));
        let front = RgbaImage::from_pixel(3, 3, Rgba([200, 0, 0, 255]));
        overlay_premultiplied(&mut canvas, &front, 7, 3, None);
        assert_eq!(canvas.get_pixel(2, 3).0, [0, 200, 0, 255]);
        assert_eq!(canvas.get_pixel(4, 3).0, [0, 0, 0, 255]);
        assert_eq!(canvas.get_pixel(8, 3).0, [200, 0, 0, 255]);
        // An excluded window raised above that foreground must erase it.
        paint_black(&mut canvas, rect(3, 2, 6, 4));
        assert_eq!(canvas.get_pixel(8, 3).0, [0, 0, 0, 255]);
    }
    #[test]
    fn transparent_foreground_reveals_black_redaction_not_hidden_background() {
        let mut canvas = RgbaImage::from_pixel(2, 1, Rgba([0, 0, 0, 255]));
        let source = RgbaImage::from_raw(2, 1, vec![64, 32, 16, 128, 255, 255, 255, 0]).unwrap();
        overlay_premultiplied(&mut canvas, &source, 0, 0, None);
        assert_eq!(canvas.get_pixel(0, 0).0, [64, 32, 16, 255]);
        assert_eq!(canvas.get_pixel(1, 0).0, [0, 0, 0, 255]);
    }
    #[test]
    fn negative_origin_and_spanning_window_clip_to_each_display() {
        let mut left = RgbaImage::from_pixel(4, 3, Rgba([255; 4]));
        paint_black(&mut left, rect(-2, -1, 4, 3));
        assert_eq!(left.get_pixel(0, 0).0, [0, 0, 0, 255]);
        assert_eq!(left.get_pixel(2, 0).0, [255; 4]);
        assert_eq!(left.get_pixel(0, 2).0, [255; 4]);
        assert!(!rect(0, 0, 4, 3).intersects(rect(4, 0, 2, 2)));
        assert!(rect(0, 0, 4, 3).intersects(rect(3, 0, 2, 2)));
    }
    #[test]
    fn restore_only_redacted_intersection_does_not_overpaint_other_windows() {
        let mut canvas = RgbaImage::from_pixel(4, 4, Rgba([0, 0, 200, 255]));
        let region = rect(0, 0, 2, 2);
        paint_black(&mut canvas, region);
        let source = RgbaImage::from_pixel(4, 4, Rgba([200, 0, 0, 255]));
        overlay_premultiplied(&mut canvas, &source, 0, 0, Some(region));
        assert_eq!(canvas.get_pixel(1, 1).0, [200, 0, 0, 255]);
        assert_eq!(canvas.get_pixel(2, 1).0, [0, 0, 200, 255]);
    }
}
