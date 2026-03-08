/*
# Python code snippet to run a custom OCR API using EasyOCR

# Create new venv
python -m venv venv
source venv/bin/activate

# Install dependencies
pip install fastapi uvicorn easyocr pillow numpy

# Create a simple FastAPI server (app.py) that uses EasyOCR to process images:

from fastapi import FastAPI, HTTPException
import base64
import io
from PIL import Image
import numpy as np
import time
import easyocr

app = FastAPI()
reader = easyocr.Reader(['en', 'ch_sim'])  # Initialize once

@app.post("/ocr")
async def read_ocr(payload: dict):
    image_b64 = payload.get("image")

    if not image_b64:
        raise HTTPException(status_code=400, detail="No image data provided")

    try:
        start = time.time()
        image_data = base64.b64decode(image_b64)
        image = Image.open(io.BytesIO(image_data))
        image_np = np.array(image)

        result = reader.readtext(image_np)

        text = "\n".join([item[1] for item in result])
        confidence = sum([item[2] for item in result]) / len(result) if result else 0.0

        print(f"OCR took {time.time() - start:.2f} seconds")

        return {
            "text": text,
            "structured_data": {},
            "confidence": confidence
        }

    except Exception as e:
        raise HTTPException(status_code=500, detail=f"OCR processing error: {str(e)}")

# Run the server:
# uvicorn app:app --host 0.0.0.0 --port 8000
#
# Configure your "CustomOcrConfig" in Rust to point to http://localhost:8000/ocr

# Clean up
deactivate
rm -rf venv app.py
*/

#[cfg(test)]
mod tests {
    use image::GenericImageView;
    use screenpipe_core::Language;
    use screenpipe_screen::custom_ocr::{perform_ocr_custom, CustomOcrConfig};
    use screenpipe_screen::utils::OcrEngine;
    use std::path::PathBuf;

    #[tokio::test]
    #[ignore]
    async fn test_custom_ocr() {
        println!("Starting custom OCR test...");

        // Load a sample image.
        let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        path.push("tests");
        path.push("testing_OCR.png");
        println!("Path to testing_OCR.png: {:?}", path);

        // Check if file exists.
        if let Ok(metadata) = std::fs::metadata(&path) {
            println!("File size: {} bytes", metadata.len());
        }

        // Open the image.
        let image = image::open(&path).expect("Failed to open test image");
        println!("Image dimensions: {:?}", image.dimensions());

        // Configure our custom OCR engine.
        let config = CustomOcrConfig {
            api_url: "http://localhost:8000/ocr".to_string(),
            api_key: "".to_string(),
            timeout_ms: 5000,
        };
        let ocr_engine = OcrEngine::Custom(config);

        // Perform the custom OCR.
        let (ocr_text, structured_data, confidence) = match ocr_engine {
            OcrEngine::Custom(ref config) => {
                perform_ocr_custom(&image, vec![Language::English], config)
                    .await
                    .expect("Custom OCR failed")
            }
            _ => panic!("Unexpected OCR engine"),
        };

        println!("OCR text: {:?}", ocr_text);
        println!("Structured data: {:?}", structured_data);
        println!("Confidence: {:?}", confidence);

        // Check some basic assumption about the output
        assert!(
            !ocr_text.is_empty(),
            "Custom OCR did not return any recognized text."
        );
    }

    #[tokio::test]
    #[ignore]
    async fn test_custom_ocr_chinese() {
        println!("Starting custom OCR Chinese test...");

        let mut path = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
        path.push("tests");
        path.push("testing_OCR_chinese.png");

        println!("Path to testing_OCR_chinese.png: {:?}", path);

        if let Ok(metadata) = std::fs::metadata(&path) {
            println!("File size: {} bytes", metadata.len());
        }

        let image = image::open(&path).expect("Failed to open Chinese test image");
        println!("Image dimensions: {:?}", image.dimensions());

        let config = CustomOcrConfig {
            api_url: "http://localhost:8000/ocr".to_string(),
            api_key: "".to_string(),
            timeout_ms: 30000000,
        };
        let ocr_engine = OcrEngine::Custom(config);

        let (ocr_text, _, _) = match ocr_engine {
            OcrEngine::Custom(ref config) => {
                perform_ocr_custom(&image, vec![Language::Chinese], config)
                    .await
                    .expect("Custom OCR failed")
            }
            _ => panic!("Unexpected OCR engine"),
        };

        println!("OCR text: {:?}", ocr_text);
        assert!(
            ocr_text.contains("管理分支"),
            "OCR failed to recognize Chinese text: {:?}",
            ocr_text
        );
    }
}
