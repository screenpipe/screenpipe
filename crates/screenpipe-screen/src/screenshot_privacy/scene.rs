// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! Pixel operations for native, positively selected window surfaces. Rectangles
//! use output pixels; no operation reads an unfiltered monitor image.
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

/// Use only coverage from a native shell surface; never copy excluded RGB.
#[cfg(any(target_os = "macos", test))]
pub(super) fn paint_black_coverage(canvas: &mut RgbaImage, mask: &RgbaImage, x: i64, y: i64) {
    for (sx, sy, pixel) in mask.enumerate_pixels() {
        let dx = x + i64::from(sx);
        let dy = y + i64::from(sy);
        if pixel[3] > 0
            && dx >= 0
            && dy >= 0
            && dx < i64::from(canvas.width())
            && dy < i64::from(canvas.height())
        {
            canvas.put_pixel(dx as u32, dy as u32, Rgba([0, 0, 0, 255]));
        }
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
        paint_black_coverage(&mut canvas, &mask, 0, 0);
        assert_eq!(canvas.get_pixel(0, 0).0, [0, 255, 255, 255]);
        assert_eq!(canvas.get_pixel(1, 0).0, [0, 0, 0, 255]);
        assert_eq!(canvas.get_pixel(2, 0).0, [0, 0, 0, 255]);
    }
    #[test]
    fn overlapping_exclusions_restore_transparency_once_per_pixel() {
        let mut regions = Vec::new();
        add_region(&mut regions, rect(0, 0, 3, 3));
        add_region(&mut regions, rect(1, 1, 3, 3));
        add_region(&mut regions, rect(0, 0, 3, 3));
        for (i, a) in regions.iter().enumerate() {
            for b in regions.iter().skip(i + 1) {
                assert!(!a.intersects(*b));
            }
        }
        let mut canvas = RgbaImage::from_pixel(4, 4, Rgba([0, 0, 0, 255]));
        let source = RgbaImage::from_pixel(4, 4, Rgba([64, 0, 0, 128]));
        for r in regions {
            overlay_premultiplied(&mut canvas, &source, 0, 0, Some(r));
        }
        assert_eq!(canvas.get_pixel(1, 1).0, [64, 0, 0, 255]);
        assert_eq!(canvas.get_pixel(3, 0).0, [0, 0, 0, 255]);
        assert_eq!(canvas.pixels().filter(|p| p[0] == 64).count(), 14);
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

/// Keep an exact disjoint union so translucent foreground pixels are never
/// blended twice where two excluded windows overlap.
#[cfg(any(target_os = "macos", test))]
pub(super) fn add_region(regions: &mut Vec<Rect>, rect: Rect) {
    let mut pending = vec![rect];
    for existing in regions.iter() {
        let mut next = Vec::new();
        for r in pending {
            let Some(i) = r.intersection(*existing) else {
                next.push(r);
                continue;
            };
            for part in [
                Rect {
                    x: r.x,
                    y: r.y,
                    width: r.width,
                    height: (i.y - r.y) as u32,
                },
                Rect {
                    x: r.x,
                    y: i.y + i64::from(i.height),
                    width: r.width,
                    height: (r.y + i64::from(r.height) - i.y - i64::from(i.height)) as u32,
                },
                Rect {
                    x: r.x,
                    y: i.y,
                    width: (i.x - r.x) as u32,
                    height: i.height,
                },
                Rect {
                    x: i.x + i64::from(i.width),
                    y: i.y,
                    width: (r.x + i64::from(r.width) - i.x - i64::from(i.width)) as u32,
                    height: i.height,
                },
            ] {
                if part.width > 0 && part.height > 0 {
                    next.push(part);
                }
            }
        }
        pending = next;
    }
    regions.extend(pending);
}
