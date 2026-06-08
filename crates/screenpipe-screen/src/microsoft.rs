use anyhow::{anyhow, Result};
use image::{DynamicImage, GenericImageView};
#[cfg(any(target_os = "windows", test))]
use screenpipe_core::Language;

#[cfg(target_os = "windows")]
use windows::{
    core::HSTRING,
    Globalization::Language as WindowsLanguage,
    Graphics::Imaging::BitmapDecoder,
    Media::Ocr::OcrEngine as WindowsOcrEngine,
    Storage::Streams::{DataWriter, InMemoryRandomAccessStream},
};

#[cfg(target_os = "windows")]
pub async fn perform_ocr_windows(
    image: &DynamicImage,
    languages: &[Language],
) -> Result<(String, String, Option<f64>)> {
    use std::io::Cursor;

    // Check image dimensions
    let (width, height) = image.dimensions();
    if width == 0 || height == 0 {
        // Return an empty result instead of panicking
        return Ok(("".to_string(), "[]".to_string(), None));
    }

    let mut buffer = Vec::new();
    image
        .write_to(&mut Cursor::new(&mut buffer), image::ImageFormat::Png)
        .map_err(|e| anyhow::anyhow!("Failed to write image to buffer: {}", e))?;

    let stream = InMemoryRandomAccessStream::new()?;
    let writer = DataWriter::CreateDataWriter(&stream)?;
    writer.WriteBytes(&buffer)?;
    writer.StoreAsync()?.get()?;
    writer.FlushAsync()?.get()?;
    stream.Seek(0)?;

    let decoder =
        BitmapDecoder::CreateWithIdAsync(BitmapDecoder::PngDecoderId()?, &stream)?.get()?;

    let bitmap = decoder.GetSoftwareBitmapAsync()?.get()?;

    let (engine, recognizer_language) = create_windows_ocr_engine(languages)?;
    tracing::debug!(
        "windows OCR using recognizer language: {}",
        recognizer_language
    );
    let result = engine.RecognizeAsync(&bitmap)?.get()?;

    let mut full_text = String::new();
    let mut ocr_results: Vec<serde_json::Value> = Vec::new();

    // Try to iterate through lines and words to get bounding boxes
    // The Windows OCR API returns lines, each containing words with bounding rects
    let lines = result.Lines()?;
    for line in lines {
        let words = line.Words()?;
        for word in words {
            let text = word.Text()?;
            let text_str = text.to_string();
            if !text_str.is_empty() {
                if !full_text.is_empty() {
                    full_text.push(' ');
                }
                full_text.push_str(&text_str);

                // Get bounding box and normalize to 0-1 range (matching Apple Vision output)
                let rect = word.BoundingRect()?;
                let img_w = width as f32;
                let img_h = height as f32;
                ocr_results.push(serde_json::json!({
                    "text": text_str,
                    "left": (rect.X / img_w).to_string(),
                    "top": (rect.Y / img_h).to_string(),
                    "width": (rect.Width / img_w).to_string(),
                    "height": (rect.Height / img_h).to_string(),
                    "conf": "1.0"  // Windows OCR doesn't provide word-level confidence
                }));
            }
        }
    }

    // Fallback if no words were extracted
    if full_text.is_empty() {
        full_text = result.Text()?.to_string();
    }

    let json_output = serde_json::to_string(&ocr_results).unwrap_or_else(|_| "[]".to_string());

    Ok((full_text, json_output, Some(1.0)))
}

#[cfg(target_os = "windows")]
fn create_windows_ocr_engine(languages: &[Language]) -> Result<(WindowsOcrEngine, String)> {
    if !languages.is_empty() {
        return create_windows_ocr_engine_for_requested_languages(languages);
    }

    match WindowsOcrEngine::TryCreateFromUserProfileLanguages() {
        Ok(engine) => {
            let tag = recognizer_language_tag(&engine);
            Ok((engine, tag))
        }
        Err(profile_err) => {
            let available_tags = available_windows_ocr_language_tags().unwrap_or_default();
            if available_tags.is_empty() {
                return Err(anyhow!(
                    "Windows OCR unavailable: no OCR recognizer languages are installed. \
                     Install a Windows OCR language pack in Settings > Time & language > Language & region. \
                     User profile engine creation failed: {}",
                    profile_err
                ));
            }

            for tag in &available_tags {
                if let Some(engine) = try_create_windows_ocr_engine_for_tag(tag)? {
                    tracing::debug!(
                        "windows OCR user profile languages did not create an engine; falling back to installed recognizer language: {}",
                        tag
                    );
                    return Ok((engine, tag.clone()));
                }
            }

            Err(anyhow!(
                "Windows OCR unavailable: user profile languages do not match any installed OCR recognizer. \
                 Available Windows OCR recognizer languages: {}. \
                 User profile engine creation failed: {}",
                format_available_tags(&available_tags),
                profile_err
            ))
        }
    }
}

#[cfg(target_os = "windows")]
fn create_windows_ocr_engine_for_requested_languages(
    languages: &[Language],
) -> Result<(WindowsOcrEngine, String)> {
    let available_tags = available_windows_ocr_language_tags().unwrap_or_default();
    let mut attempted_tags: Vec<&'static str> = Vec::new();

    for language in languages {
        for tag in windows_language_tags_for(language) {
            if attempted_tags.contains(&tag) {
                continue;
            }
            attempted_tags.push(tag);

            if let Some(engine) = try_create_windows_ocr_engine_for_tag(tag)? {
                return Ok((engine, tag.to_string()));
            }
        }
    }

    Err(anyhow!(
        "Windows OCR unavailable for requested language(s): {}. \
         Tried Windows language tag(s): {}. \
         Available Windows OCR recognizer languages: {}. \
         Install the matching Windows OCR language pack or pass a language that is available.",
        languages
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join(", "),
        attempted_tags.join(", "),
        format_available_tags(&available_tags)
    ))
}

#[cfg(target_os = "windows")]
fn try_create_windows_ocr_engine_for_tag(tag: &str) -> Result<Option<WindowsOcrEngine>> {
    let language_tag = HSTRING::from(tag);
    let language = WindowsLanguage::CreateLanguage(&language_tag)?;
    if !WindowsOcrEngine::IsLanguageSupported(&language)? {
        return Ok(None);
    }

    match WindowsOcrEngine::TryCreateFromLanguage(&language) {
        Ok(engine) => Ok(Some(engine)),
        Err(err) if is_null_ocr_engine_error(&err) => Ok(None),
        Err(err) => Err(anyhow!(
            "failed to create Windows OCR engine for language tag '{}': {}",
            tag,
            err
        )),
    }
}

#[cfg(target_os = "windows")]
fn is_null_ocr_engine_error(err: &windows::core::Error) -> bool {
    // windows-rs reports null WinRT interface results as an Error whose HRESULT
    // is success. Turn that confusing "operation completed successfully" state
    // into a normal "no engine for this language" branch.
    err.code().0 == 0
}

#[cfg(target_os = "windows")]
fn recognizer_language_tag(engine: &WindowsOcrEngine) -> String {
    engine
        .RecognizerLanguage()
        .and_then(|language| language.LanguageTag())
        .map(|tag| tag.to_string())
        .unwrap_or_else(|_| "unknown".to_string())
}

#[cfg(target_os = "windows")]
fn available_windows_ocr_language_tags() -> Result<Vec<String>> {
    let languages = WindowsOcrEngine::AvailableRecognizerLanguages()?;
    let mut tags = Vec::new();
    for language in languages {
        tags.push(language.LanguageTag()?.to_string());
    }
    Ok(tags)
}

#[cfg(any(target_os = "windows", test))]
fn windows_language_tags_for(language: &Language) -> Vec<&'static str> {
    match language {
        Language::English => vec!["en-US", "en"],
        Language::Chinese => vec!["zh-Hans", "zh-CN", "zh-Hans-CN", "zh"],
        Language::German => vec!["de-DE", "de"],
        Language::Spanish => vec!["es-ES", "es-MX", "es"],
        Language::Russian => vec!["ru-RU", "ru"],
        Language::Korean => vec!["ko-KR", "ko"],
        Language::French => vec!["fr-FR", "fr-CA", "fr"],
        Language::Japanese => vec!["ja-JP", "ja"],
        Language::Portuguese => vec!["pt-BR", "pt-PT", "pt"],
        Language::Turkish => vec!["tr-TR", "tr"],
        Language::Polish => vec!["pl-PL", "pl"],
        Language::Dutch => vec!["nl-NL", "nl"],
        Language::Arabic => vec!["ar-SA", "ar"],
        Language::Swedish => vec!["sv-SE", "sv"],
        Language::Italian => vec!["it-IT", "it"],
        Language::Hindi => vec!["hi-IN", "hi"],
        Language::Vietnamese => vec!["vi-VN", "vi"],
        Language::Finnish => vec!["fi-FI", "fi"],
        Language::Hebrew => vec!["he-IL", "he"],
        Language::Ukrainian => vec!["uk-UA", "uk"],
        Language::Greek => vec!["el-GR", "el"],
        Language::Czech => vec!["cs-CZ", "cs"],
        Language::Romanian => vec!["ro-RO", "ro"],
        Language::Danish => vec!["da-DK", "da"],
        Language::Hungarian => vec!["hu-HU", "hu"],
        Language::Norwegian => vec!["nb-NO", "nn-NO", "no"],
        Language::Thai => vec!["th-TH", "th"],
        Language::Bulgarian => vec!["bg-BG", "bg"],
        Language::Lithuanian => vec!["lt-LT", "lt"],
        Language::Latvian => vec!["lv-LV", "lv"],
        Language::Serbian => vec!["sr-Cyrl-RS", "sr-Latn-RS", "sr"],
        Language::Slovenian => vec!["sl-SI", "sl"],
        Language::Estonian => vec!["et-EE", "et"],
        Language::Croatian => vec!["hr-HR", "hr"],
        _ => vec![language.as_lang_code()],
    }
}

#[cfg(target_os = "windows")]
fn format_available_tags(tags: &[String]) -> String {
    if tags.is_empty() {
        "none".to_string()
    } else {
        tags.join(", ")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn windows_language_tags_include_chinese_simplified_candidates() {
        let tags = windows_language_tags_for(&Language::Chinese);
        assert_eq!(tags[0], "zh-Hans");
        assert!(tags.contains(&"zh-CN"));
        assert!(tags.contains(&"zh"));
    }

    #[test]
    fn windows_language_tags_include_english_fallback() {
        let tags = windows_language_tags_for(&Language::English);
        assert_eq!(tags, vec!["en-US", "en"]);
    }

    #[test]
    fn windows_language_tags_default_to_core_lang_code() {
        let tags = windows_language_tags_for(&Language::Catalan);
        assert_eq!(tags, vec!["ca"]);
    }
}
