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

    languages
        .iter()
        .filter_map(|lang| map.get(lang).map(|&s| s.to_string()))
        .collect()
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
                    let Ok(bbox_result) =
                        observation_result.bounding_box_for_range(ns::Range::new(0, text.len()))
                    else {
                        // Skip bounding box if it fails, still capture the text
                        overall_confidence += confidence;
                        ocr_text.push_str(text.to_string().as_str());
                        return;
                    };
                    let bbox = bbox_result.bounding_box();
                    let x = bbox.origin.x;
                    let y_vision = bbox.origin.y; // Vision: bottom-left origin, Y up
                    let height = bbox.size.height;
                    let width = bbox.size.width;
                    // Convert to top-left origin (same as other OCR engines) so pipeline/DB stay consistent
                    let top = 1.0 - y_vision - height;

                    ocr_results_vec.push(serde_json::json!({
                        "level": "0",
                        "page_num": "0",
                        "block_num": "0",
                        "par_num": "0",
                        "line_num": "0",
                        "word_num": "0",
                        "left": x.to_string(),
                        "top": top.to_string(),
                        "width": width.to_string(),
                        "height": height.to_string(),
                        "conf": confidence.to_string(),
                        "text": text.to_string(),
                    }));

                    overall_confidence += confidence;
                    ocr_text.push_str(text.to_string().as_str());
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
