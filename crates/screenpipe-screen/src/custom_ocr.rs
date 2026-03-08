use anyhow::Result;
use base64::{engine::general_purpose, Engine as _};
use image::DynamicImage;
use screenpipe_core::Language;
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CustomOcrConfig {
    pub api_url: String,
    pub api_key: String,
    pub timeout_ms: u64,
}

impl Default for CustomOcrConfig {
    fn default() -> Self {
        CustomOcrConfig {
            api_url: "http://localhost:8000/ocr".to_string(),
            api_key: "".to_string(),
            timeout_ms: 5000,
        }
    }
}

impl From<screenpipe_db::CustomOcrConfig> for CustomOcrConfig {
    fn from(config: screenpipe_db::CustomOcrConfig) -> Self {
        CustomOcrConfig {
            api_url: config.api_url,
            api_key: config.api_key,
            timeout_ms: config.timeout_ms,
        }
    }
}

impl From<CustomOcrConfig> for screenpipe_db::CustomOcrConfig {
    fn from(config: CustomOcrConfig) -> Self {
        screenpipe_db::CustomOcrConfig {
            api_url: config.api_url,
            api_key: config.api_key,
            timeout_ms: config.timeout_ms,
        }
    }
}

pub async fn perform_ocr_custom(
    image: &DynamicImage,
    languages: Vec<Language>,
    config: &CustomOcrConfig,
) -> Result<(String, String, Option<f64>)> {
    // Convert image to RGB before encoding to JPEG
    let rgb_image = image.to_rgb8();

    // Convert image to base64 JPEG
    let mut buffer = Vec::new();
    rgb_image.write_to(
        &mut std::io::Cursor::new(&mut buffer),
        image::ImageFormat::Jpeg,
    )?;
    let base64_image = general_purpose::STANDARD.encode(buffer);

    // Prepare the request payload
    let payload = serde_json::json!({
        "image": base64_image,
        "languages": languages.iter().map(|l| l.to_string()).collect::<Vec<_>>(),
    });

    // Create client with timeout
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(config.timeout_ms))
        .build()?;

    // Make the API request
    let response = client
        .post(&config.api_url)
        .header("Authorization", format!("Bearer {}", config.api_key))
        .json(&payload)
        .send()
        .await?;

    // Handle the response
    let ocr_result: OcrResponse = response.json().await?;

    Ok((
        ocr_result.text,
        ocr_result.structured_data.to_string(),
        Some(ocr_result.confidence),
    ))
}

#[derive(Debug, Deserialize)]
struct OcrResponse {
    text: String,
    structured_data: serde_json::Value,
    confidence: f64,
}
