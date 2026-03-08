use image::{DynamicImage, GenericImageView};
use rusty_tesseract::{Args, DataOutput, Image};
use screenpipe_core::{Language, TESSERACT_LANGUAGES};
use std::collections::HashMap;
use tracing::warn;

/// Ensure TESSDATA_PREFIX is set so tesseract can find language data files.
fn ensure_tessdata_prefix() {
    if std::env::var("TESSDATA_PREFIX").is_ok() {
        return;
    }
    // Common distro paths for tessdata
    let candidates = [
        "/usr/share/tesseract-ocr/5/tessdata",
        "/usr/share/tesseract-ocr/4/tessdata",
        "/usr/share/tesseract/tessdata",
        "/usr/share/tessdata",
        "/usr/local/share/tessdata",
    ];
    for path in &candidates {
        if std::path::Path::new(path).join("eng.traineddata").exists() {
            std::env::set_var("TESSDATA_PREFIX", path);
            return;
        }
    }
}

pub fn perform_ocr_tesseract(
    image: &DynamicImage,
    languages: Vec<Language>,
) -> (String, String, Option<f64>) {
    ensure_tessdata_prefix();

    let language_string = match languages.is_empty() {
        true => "eng".to_string(),
        _ => TESSERACT_LANGUAGES
            .iter()
            .filter_map(|(key, val)| {
                if languages.iter().any(|l| l == val) {
                    Some(key.to_string())
                } else {
                    None
                }
            })
            .collect::<Vec<String>>()
            .join("+"),
    };
    let args = Args {
        lang: language_string,
        config_variables: HashMap::from([("tessedit_create_tsv".into(), "1".into())]),
        dpi: Some(600), // 150 is a balanced option, 600 seems faster surprisingly, the bigger the number the more granualar result
        psm: Some(1), // PSM 1: Automatic page segmentation with OSD. PSM 3: Automatic page segmentation with OSD
        oem: Some(1), //1: Neural nets LSTM engine only,    3: Default, based on what is available. (Default)
    };

    let ocr_image = match Image::from_dynamic_image(image) {
        Ok(img) => img,
        Err(e) => {
            warn!("tesseract: failed to convert image: {}", e);
            return (String::new(), "[]".to_string(), None);
        }
    };

    // Extract data output
    let data_output = match rusty_tesseract::image_to_data(&ocr_image, &args) {
        Ok(data) => data,
        Err(e) => {
            warn!("tesseract: OCR failed: {}", e);
            return (String::new(), "[]".to_string(), None);
        }
    };

    // Extract text from data output
    let text = data_output_to_text(&data_output);
    let (img_w, img_h) = image.dimensions();
    let json_output = data_output_to_json(&data_output, img_w, img_h);

    let overall_confidence = calculate_overall_confidence(&data_output);

    (text, json_output, Some(overall_confidence))
}

fn data_output_to_text(data_output: &DataOutput) -> String {
    let mut text = String::new();
    for record in &data_output.data {
        if !record.text.is_empty() {
            if !text.is_empty() {
                text.push(' ');
            }
            text.push_str(&record.text);
        }
    }
    text
}

fn data_output_to_json(data_output: &DataOutput, img_w: u32, img_h: u32) -> String {
    let mut words: Vec<HashMap<String, String>> = Vec::new();
    let w = if img_w > 0 { img_w as f64 } else { 1.0 };
    let h = if img_h > 0 { img_h as f64 } else { 1.0 };

    for record in &data_output.data {
        // Only include records that have text (word_num > 0 means it's a word)
        if record.word_num > 0 && !record.text.is_empty() {
            let mut word_data = HashMap::new();
            word_data.insert("text".to_string(), record.text.clone());
            word_data.insert("conf".to_string(), format!("{:.2}", record.conf));
            // Normalize bounding box coordinates to 0-1 range (matching Apple Vision output)
            word_data.insert("left".to_string(), (record.left as f64 / w).to_string());
            word_data.insert("top".to_string(), (record.top as f64 / h).to_string());
            word_data.insert("width".to_string(), (record.width as f64 / w).to_string());
            word_data.insert("height".to_string(), (record.height as f64 / h).to_string());
            // Include position metadata
            word_data.insert("level".to_string(), record.level.to_string());
            word_data.insert("page_num".to_string(), record.page_num.to_string());
            word_data.insert("block_num".to_string(), record.block_num.to_string());
            word_data.insert("par_num".to_string(), record.par_num.to_string());
            word_data.insert("line_num".to_string(), record.line_num.to_string());
            word_data.insert("word_num".to_string(), record.word_num.to_string());
            words.push(word_data);
        }
    }

    serde_json::to_string(&words).unwrap_or_else(|_| "[]".to_string())
}

fn calculate_overall_confidence(data_output: &DataOutput) -> f64 {
    let total_conf: f32 = data_output.data.iter().map(|record| record.conf).sum();
    let count = data_output.data.len();
    if count > 0 {
        (total_conf / count as f32) as f64
    } else {
        0.0
    }
}
