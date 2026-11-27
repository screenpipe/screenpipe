// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

// Included after the production function by safeguards.test.ts. No Win32,
// image library, Cargo dependency resolution, model, or customer data required.
#[test]
fn allowed_pixels_survive_compositor_differences() {
    for rgb in [[245, 245, 245], [0, 255, 255], [12, 34, 56], [0, 0, 0]] {
        let mut target = [0, 0, 0, 255];
        restore_opaque_witness_pixel(&[rgb[0], rgb[1], rgb[2], 255], &mut target);
        assert_eq!(&target[..3], &rgb, "opaque allowed content was blacked out");
        assert_eq!(target[3], 255);
    }
}

#[test]
fn translucent_pixels_cannot_reveal_unverified_background() {
    for alpha in 0..255 {
        let mut target = [0, 0, 0, 255];
        restore_opaque_witness_pixel(&[255, 0, 255, alpha], &mut target);
        assert_eq!(
            target,
            [0, 0, 0, 255],
            "nonopaque witness leaked at {alpha}"
        );
    }
}

#[test]
fn restoration_preserves_output_alpha() {
    let mut target = [0, 0, 0, 128];
    restore_opaque_witness_pixel(&[0, 255, 255, 255], &mut target);
    assert_eq!(target, [0, 255, 255, 128]);
}

#[test]
fn every_allowed_pixel_is_restored_not_just_one_marker() {
    // The old probe's `allowed > 0` could pass a mostly black screenshot.
    let mut output = [[0, 0, 0, 255]; 256];
    for pixel in &mut output {
        restore_opaque_witness_pixel(&[0, 255, 255, 255], pixel);
    }
    assert!(output.iter().all(|pixel| *pixel == [0, 255, 255, 255]));
}
