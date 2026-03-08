use anyhow::{anyhow, Result};
use image::{codecs::png::PngEncoder, DynamicImage, ImageEncoder};
use log::error;
use reqwest::multipart::{Form, Part};
use screenpipe_core::{Language, TESSERACT_LANGUAGES};
use serde_json;
use std::collections::HashMap;
use std::env;
use std::io::Cursor;
use tokio::time::{timeout, Duration};

pub async fn perform_ocr_cloud(
    image: &DynamicImage,
    languages: Vec<Language>,
) -> Result<(String, String, Option<f64>)> {
    let api_key = match env::var("UNSTRUCTURED_API_KEY") {
        Ok(key) => key,
        Err(_) => {
            error!("UNSTRUCTURED_API_KEY environment variable is not set. Please set it to use the OCR cloud service.");
            return Err(anyhow!("Missing API key"));
        }
    };
    let api_url = "https://api.unstructuredapp.io/general/v0/general".to_string();

    let mut buffer = Vec::new();
    let mut cursor = Cursor::new(&mut buffer);
    PngEncoder::new(&mut cursor)
        .write_image(
            image.as_bytes(),
            image.width(),
            image.height(),
            image.color().into(),
        )
        .unwrap();

    let part = Part::bytes(buffer)
        .file_name("image.png".to_string())
        .mime_str("image/png")
        .unwrap();

    let mut form = Form::new()
        .part("files", part)
        .text("strategy", "auto")
        .text("coordinates", "true");

    if !languages.is_empty() {
        form = form.text(
            "languages",
            TESSERACT_LANGUAGES
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
        );
    }

    let client = reqwest::Client::new();
    let response = match timeout(
        Duration::from_secs(180),
        client
            .post(&api_url)
            .header("accept", "application/json")
            .header("unstructured-api-key", &api_key)
            .multipart(form)
            .send(),
    )
    .await
    {
        Ok(Ok(response)) => response,
        Ok(Err(e)) => return Err(anyhow!("Request error: {}", e)),
        Err(_) => return Err(anyhow!("Request timed out")),
    };

    let response_text = if response.status().is_success() {
        response.text().await?
    } else {
        return Err(anyhow!("Error: {}", response.status()));
    };

    let json_output = response_text.clone();

    let parsed_response: Vec<HashMap<String, serde_json::Value>> =
        serde_json::from_str(&response_text).unwrap();
    let text = parsed_response
        .iter()
        .filter_map(|item| item.get("text").and_then(|v| v.as_str()))
        .collect::<Vec<&str>>()
        .join(" ");

    let overall_confidence = calculate_overall_confidence(&parsed_response);

    Ok((text, json_output, Some(overall_confidence)))
}

fn calculate_overall_confidence(parsed_response: &[HashMap<String, serde_json::Value>]) -> f64 {
    let confidence_sum: f64 = parsed_response
        .iter()
        .filter_map(|item| item.get("confidence").and_then(|v| v.as_f64()))
        .sum();
    let count = parsed_response.len();
    if count > 0 {
        confidence_sum / count as f64
    } else {
        0.0
    }
}
