#[cfg(target_os = "macos")]
use cidre::{
    cv::{PixelBuf, PixelFormat},
    ns,
    vn::{self, ImageRequestHandler, RecognizeTextRequest},
};
use image::DynamicImage;
use image::GenericImageView;
use screenpipe_core::Language;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::OnceLock;
use std::{ffi::c_void, ptr::null_mut};
use tracing::error;

static APPLE_LANGUAGE_MAP: OnceLock<HashMap<Language, &'static str>> = OnceLock::new();

pub fn get_apple_languages(languages: &[Language]) -> Vec<String> {
    let map = APPLE_LANGUAGE_MAP.get_or_init(|| {
        let mut m = HashMap::new();
        m.insert(Language::English, "en-US");
        m.insert(Language::Spanish, "es-ES");
        m.insert(Language::French, "fr-FR");
        m.insert(Language::German, "de-DE");
        m.insert(Language::Italian, "it-IT");
        m.insert(Language::Portuguese, "pt-BR");
        m.insert(Language::Russian, "ru-RU");
        m.insert(Language::Chinese, "zh-Hans");
        m.insert(Language::Korean, "ko-KR");
        m.insert(Language::Japanese, "ja-JP");
        m.insert(Language::Ukrainian, "uk-UA");
        m.insert(Language::Thai, "th-TH");
        m.insert(Language::Arabic, "ar-SA");
        m
    });

    let mut result: Vec<String> = languages
        .iter()
        .filter_map(|lang| map.get(lang).map(|&s| s.to_string()))
        .collect();
    if languages.contains(&Language::Chinese) && !result.contains(&"zh-Hant".to_string()) {
        result.push("zh-Hant".to_string());
    }
    result
}

#[allow(dead_code)]
#[derive(Serialize, Deserialize, Debug)]
struct OcrResultBBox {
    x: f64,
    y: f64,
    height: f64,
    width: f64,
}

#[allow(dead_code)]
#[derive(Serialize, Deserialize, Debug)]
struct OcrTextElement {
    bounding_box: Vec<OcrResultBBox>,
    confidence: f32,
    text: String,
}

#[allow(dead_code)]
#[derive(Serialize, Deserialize, Debug)]
struct OcrResult {
    ocr_result: String,
    text_elements: Vec<OcrTextElement>,
    overall_confidence: f32,
}

#[no_mangle]
#[cfg(target_os = "macos")]
extern "C" fn release_callback(_refcon: *mut c_void, _data_ptr: *const *const c_void) {
    // Implement your release logic here
}

#[cfg(target_os = "macos")]
fn utf16_word_ranges(s: &str) -> Vec<(usize, usize, String)> {
    let mut out = Vec::new();
    let mut utf16_pos: usize = 0;
    let mut word_start: Option<usize> = None;
    let mut word_buf = String::new();

    for c in s.chars() {
        let c_utf16 = c.len_utf16();
        if c.is_whitespace() {
            if let Some(start) = word_start.take() {
                out.push((start, utf16_pos - start, std::mem::take(&mut word_buf)));
            }
        } else {
            if word_start.is_none() {
                word_start = Some(utf16_pos);
            }
            word_buf.push(c);
        }
        utf16_pos += c_utf16;
    }
    if let Some(start) = word_start.take() {
        out.push((start, utf16_pos - start, word_buf));
    }
    out
}

#[cfg(target_os = "macos")]
pub fn perform_ocr_apple(
    image: &DynamicImage,
    languages: &[Language],
) -> (String, String, Option<f64>) {
    cidre::objc::ar_pool(|| {
        // Convert languages to Apple format and create ns::Array
        let apple_languages = get_apple_languages(languages);
        let mut languages_array = ns::ArrayMut::<ns::String>::with_capacity(apple_languages.len());
        apple_languages.iter().for_each(|language| {
            languages_array.push(&ns::String::with_str(language));
        });

        let (width, height) = image.dimensions();
        let rgb = image.grayscale().to_luma8();
        let raw_data = rgb.as_raw();

        let mut overall_confidence = 0.0;
        let default_ocr_result = (
            String::from(""),
            String::from("[]"),
            Some(overall_confidence),
        );

        // Guard against zero-dimension images that would cause CoreVideo errors
        if width == 0 || height == 0 {
            error!(
                "Cannot perform OCR on zero-dimension image ({}x{})",
                width, height
            );
            return default_ocr_result;
        }

        let width = usize::try_from(width).unwrap();
        let height = usize::try_from(height).unwrap();

        let mut pixel_buf_out = None;

        let pixel_buf = match unsafe {
            PixelBuf::create_with_bytes_in(
                width,
                height,
                PixelFormat::ONE_COMPONENT_8,
                raw_data.as_ptr() as *mut c_void,
                width,
                release_callback,
                null_mut(),
                None,
                &mut pixel_buf_out,
                None,
            )
            .to_result_unchecked(pixel_buf_out)
        } {
            Ok(buf) => buf,
            Err(e) => {
                error!(
                    "Failed to create pixel buffer for OCR ({}x{}): {:?}",
                    width, height, e
                );
                return default_ocr_result;
            }
        };

        let handler = match ImageRequestHandler::with_cv_pixel_buf(&pixel_buf, None) {
            Some(h) => h,
            None => {
                error!("Failed to create image request handler for OCR");
                return default_ocr_result;
            }
        };
        let mut request = RecognizeTextRequest::new();
        request.set_recognition_langs(&languages_array);
        request.set_uses_lang_correction(false);
        let requests = ns::Array::<vn::Request>::from_slice(&[&request]);
        let result = handler.perform(&requests);

        if result.is_err() {
            return default_ocr_result;
        }

        if let Some(results) = request.results() {
            if !results.is_empty() {
                let mut ocr_results_vec: Vec<serde_json::Value> = Vec::new();
                let mut ocr_text: String = String::new();
                results.iter().for_each(|result| {
                    let Ok(observation_result) = result.top_candidates(1).get(0) else {
                        return;
                    };
                    let text = observation_result.string();
                    let confidence = observation_result.confidence() as f64;
                    let s = text.to_string();
                    if s.is_empty() {
                        return;
                    }

                    overall_confidence += confidence;
                    ocr_text.push_str(&s);

                    // Apple Vision groups multiple words/lines into one observation. Tokenize
                    // by whitespace and emit one record per word with its own bbox so the
                    // timeline search highlight can be tight on the matched word.
                    // bounding_box_for_range expects an NSRange in UTF-16 code units, not
                    // Rust byte offsets — walk chars summing len_utf16() to build the offsets.
                    let word_ranges = utf16_word_ranges(&s);
                    if word_ranges.is_empty() {
                        return;
                    }

                    let emit_record = |ocr_results_vec: &mut Vec<serde_json::Value>,
                                       word_text: &str,
                                       word_num: usize,
                                       utf16_start: usize,
                                       utf16_len: usize| {
                        let Ok(bbox_result) = observation_result
                            .bounding_box_for_range(ns::Range::new(utf16_start, utf16_len))
                        else {
                            return;
                        };
                        let bbox = bbox_result.bounding_box();
                        let x = bbox.origin.x;
                        let y_vision = bbox.origin.y; // Vision: bottom-left origin, Y up
                        let height = bbox.size.height;
                        let width = bbox.size.width;
                        // Convert to top-left origin (same as other OCR engines)
                        let top = 1.0 - y_vision - height;

                        // Stay on level "0" (Apple Native, flat) so frames hit the
                        // bulk fast-path in insert_ocr_elements; level 5 would route
                        // every word through the per-row Tesseract hierarchical path.
                        ocr_results_vec.push(serde_json::json!({
                            "level": "0",
                            "page_num": "0",
                            "block_num": "0",
                            "par_num": "0",
                            "line_num": "0",
                            "word_num": word_num.to_string(),
                            "left": x.to_string(),
                            "top": top.to_string(),
                            "width": width.to_string(),
                            "height": height.to_string(),
                            "conf": confidence.to_string(),
                            "text": word_text.to_string(),
                        }));
                    };

                    for (i, (utf16_start, utf16_len, word_text)) in word_ranges.iter().enumerate() {
                        emit_record(
                            &mut ocr_results_vec,
                            word_text,
                            i + 1,
                            *utf16_start,
                            *utf16_len,
                        );
                    }
                });

                let json_output_string =
                    serde_json::to_string(&ocr_results_vec).unwrap_or_else(|e| {
                        error!("Failed to serialize JSON output: {}", e);
                        "[]".to_string()
                    });

                return (ocr_text, json_output_string, Some(overall_confidence));
            }
        }

        default_ocr_result
    })
}

#[cfg(all(target_os = "macos", test))]
mod tests {
    use super::utf16_word_ranges;

    #[test]
    fn empty_string_yields_empty() {
        assert!(utf16_word_ranges("").is_empty());
    }

    #[test]
    fn whitespace_only_yields_empty() {
        assert!(utf16_word_ranges("   \t\n  ").is_empty());
    }

    #[test]
    fn single_word_one_range() {
        let r = utf16_word_ranges("rotor");
        assert_eq!(r.len(), 1);
        assert_eq!(r[0], (0, 5, "rotor".to_string()));
    }

    #[test]
    fn two_words_two_ranges() {
        let r = utf16_word_ranges("hello world");
        assert_eq!(r.len(), 2);
        assert_eq!(r[0], (0, 5, "hello".to_string()));
        assert_eq!(r[1], (6, 5, "world".to_string()));
    }

    #[test]
    fn leading_and_trailing_whitespace_skipped() {
        let r = utf16_word_ranges("  rotor  ");
        assert_eq!(r.len(), 1);
        assert_eq!(r[0], (2, 5, "rotor".to_string()));
    }

    #[test]
    fn cjk_no_whitespace_collapses_to_one_range() {
        // No whitespace in CJK strings → single range covering the whole string.
        // Each Han char is 1 UTF-16 code unit (BMP), so utf16_len == char count.
        let r = utf16_word_ranges("你好世界");
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].0, 0);
        assert_eq!(r[0].1, 4);
        assert_eq!(r[0].2, "你好世界");
    }

    #[test]
    fn supplementary_chars_count_as_two_utf16_units() {
        // Emoji 🎉 (U+1F389) lives outside the BMP and takes 2 UTF-16 code units.
        let r = utf16_word_ranges("a 🎉 b");
        assert_eq!(r.len(), 3);
        assert_eq!(r[0], (0, 1, "a".to_string()));
        // 🎉 starts at utf16 offset 2, length 2
        assert_eq!(r[1].0, 2);
        assert_eq!(r[1].1, 2);
        // 'b' is at utf16 offset 5 (1 + 1 + 2 + 1)
        assert_eq!(r[2].0, 5);
        assert_eq!(r[2].1, 1);
    }
}
