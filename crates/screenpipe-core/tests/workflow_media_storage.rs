// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
use screenpipe_core::workflows::discard_screenshot_pixels;
use serde_json::json;

#[test]
fn legacy_catalogs_keep_capture_identity_without_pixels_in_retained_drafts() {
    let capture = json!({"frameId":42,"timestamp":"2026-09-22T10:00:00Z","app":"Notes",
        "visualVerified":true,"dataUrl":format!("data:image/jpeg;base64,{}", "x".repeat(200_000))});
    let mut catalog = json!({"analysis":{"workflows":[{"id":"wf-notes","userCorrection":"Keep my edits",
        "stages":[{"screenshot":capture,"screenshots":[capture]}]}]},
        "agentWorkspace":{"drafts":{"review":{"payload":{"screenshots":[capture]}}}},
        "unrelated":{"dataUrl":"retain arbitrary user content"}});
    let before = serde_json::to_vec(&catalog).unwrap().len();
    discard_screenshot_pixels(&mut catalog);
    let after = serde_json::to_vec(&catalog).unwrap().len();
    assert!(before > 600_000 && after < 1500);
    let shot = &catalog["analysis"]["workflows"][0]["stages"][0]["screenshot"];
    assert_eq!(shot["frameId"], 42);
    assert_eq!(shot["timestamp"], "2026-09-22T10:00:00Z");
    assert_eq!(shot["visualVerified"], true);
    assert_eq!(shot["dataUrl"], "");
    assert_eq!(
        catalog["analysis"]["workflows"][0]["userCorrection"],
        "Keep my edits"
    );
    assert_eq!(
        catalog["unrelated"]["dataUrl"],
        "retain arbitrary user content"
    );
    let once = catalog.clone();
    discard_screenshot_pixels(&mut catalog);
    assert_eq!(once, catalog);
    println!("synthetic catalog bytes: {before} -> {after}");
}
