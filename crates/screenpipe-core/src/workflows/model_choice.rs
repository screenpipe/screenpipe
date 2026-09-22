// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

//! One persisted choice for interactive and scheduled Workflows AI.
use anyhow::{bail, Result};
use std::path::Path;

pub const PRIVATE_MODEL: &str = "glm-5.3-flash-reap50-iq3m";
pub fn selected_model() -> Result<&'static str> {
    read_model(&crate::paths::default_screenpipe_data_dir().join("workflows-model.json"))
}
fn read_model(path: &Path) -> Result<&'static str> {
    let text = match std::fs::read_to_string(path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok("auto"),
        Err(error) => return Err(error.into()),
    };
    match serde_json::from_str::<serde_json::Value>(&text)?["mode"].as_str() {
        Some("intelligent") => Ok("auto"),
        Some("private") => Ok(PRIVATE_MODEL),
        _ => {
            bail!("The saved Workflows AI choice is invalid. Select Intelligent or Private again.")
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preserves_private_selection_and_rejects_corrupt_preferences() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("model.json");
        assert_eq!(read_model(&path).unwrap(), "auto");
        std::fs::write(&path, r#"{"mode":"private"}"#).unwrap();
        assert_eq!(read_model(&path).unwrap(), PRIVATE_MODEL);
        for invalid in ["{", r#"{"mode":"custom"}"#, "null"] {
            std::fs::write(&path, invalid).unwrap();
            assert!(read_model(&path).is_err());
        }
    }
}
