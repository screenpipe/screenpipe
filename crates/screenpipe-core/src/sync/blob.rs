//! Encrypted blob handling for cloud sync.
//!
//! This module handles packaging, encrypting, and decrypting data blobs
//! that are stored in the cloud.

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde::{Deserialize, Serialize};

use super::crypto::{
    compute_checksum, decrypt, encrypt, generate_nonce, generate_search_tokens_from_text,
    HMAC_SIZE, NONCE_SIZE,
};
use super::error::{SyncError, SyncResult};
use super::keys::SyncKeys;

/// Types of data blobs that can be synced.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum BlobType {
    /// Screen capture frames (images)
    Frames,
    /// Audio recordings
    Audio,
    /// Transcriptions of audio
    Transcripts,
    /// OCR text from screen captures
    Ocr,
    /// Accessibility text from screen (UI element traversal)
    Accessibility,
    /// User input events (clicks, keystrokes, clipboard)
    Input,
    /// Pipe configuration manifest (for cross-device pipe sync)
    #[serde(rename = "pipe_config")]
    PipeConfig,
    /// Connection configuration manifest (cross-device credential sync).
    #[serde(rename = "connection_config")]
    ConnectionConfig,
    /// Memories manifest (for cross-device memories sync). Mirrors the
    /// PipeConfig pattern: a single JSON manifest blob containing every
    /// memory the user has, last-write-wins merged across machines.
    Memories,
}

impl BlobType {
    pub fn as_str(&self) -> &'static str {
        match self {
            BlobType::Frames => "frames",
            BlobType::Audio => "audio",
            BlobType::Transcripts => "transcripts",
            BlobType::Ocr => "ocr",
            BlobType::Accessibility => "accessibility",
            BlobType::Input => "input",
            BlobType::PipeConfig => "pipe_config",
            BlobType::ConnectionConfig => "connection_config",
            BlobType::Memories => "memories",
        }
    }
}

impl std::fmt::Display for BlobType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.as_str())
    }
}

/// An encrypted blob ready for upload.
#[derive(Debug)]
pub struct EncryptedBlob {
    /// The encrypted data (ciphertext + auth tag)
    pub ciphertext: Vec<u8>,
    /// The nonce used for encryption (must be stored for decryption)
    pub nonce: [u8; NONCE_SIZE],
    /// SHA-256 checksum of the plaintext (for integrity verification)
    pub checksum: String,
    /// The type of data in this blob
    pub blob_type: BlobType,
    /// Size of the original plaintext in bytes
    pub plaintext_size: usize,
    /// Search tokens extracted from the content (for text-based blobs)
    pub search_tokens: Vec<[u8; HMAC_SIZE]>,
}

impl EncryptedBlob {
    /// Get the nonce as base64.
    pub fn nonce_base64(&self) -> String {
        BASE64.encode(self.nonce)
    }

    /// Get search tokens as base64 strings.
    pub fn search_tokens_base64(&self) -> Vec<String> {
        self.search_tokens
            .iter()
            .map(|t| BASE64.encode(t))
            .collect()
    }
}

/// A decrypted blob.
#[derive(Debug)]
pub struct DecryptedBlob {
    /// The decrypted plaintext data
    pub data: Vec<u8>,
    /// The type of data
    pub blob_type: BlobType,
}

/// Encrypt data into a blob for upload.
///
/// # Arguments
/// * `data` - The plaintext data to encrypt
/// * `blob_type` - The type of data
/// * `keys` - The sync keys for encryption
/// * `text_content` - Optional text content for search token generation
///
/// # Returns
/// An encrypted blob ready for upload
pub fn encrypt_blob(
    data: &[u8],
    blob_type: BlobType,
    keys: &SyncKeys,
    text_content: Option<&str>,
) -> SyncResult<EncryptedBlob> {
    // Generate unique nonce
    let nonce = generate_nonce();

    // Compute checksum of plaintext
    let checksum = compute_checksum(data);

    // Encrypt the data
    let ciphertext = encrypt(data, keys.data_key(), &nonce)?;

    // Generate search tokens if text content is provided
    let search_tokens = if let Some(text) = text_content {
        generate_search_tokens_from_text(text, keys.search_key())?
    } else {
        Vec::new()
    };

    Ok(EncryptedBlob {
        ciphertext,
        nonce,
        checksum,
        blob_type,
        plaintext_size: data.len(),
        search_tokens,
    })
}

/// Decrypt a blob downloaded from the cloud.
///
/// # Arguments
/// * `ciphertext` - The encrypted data
/// * `nonce` - The nonce used during encryption (base64)
/// * `expected_checksum` - The expected SHA-256 checksum (optional, for verification)
/// * `blob_type` - The type of data
/// * `keys` - The sync keys for decryption
///
/// # Returns
/// The decrypted blob data
pub fn decrypt_blob(
    ciphertext: &[u8],
    nonce: &str,
    expected_checksum: Option<&str>,
    blob_type: BlobType,
    keys: &SyncKeys,
) -> SyncResult<DecryptedBlob> {
    // Decode nonce
    let nonce_bytes = BASE64.decode(nonce)?;
    if nonce_bytes.len() != NONCE_SIZE {
        return Err(SyncError::DataCorruption(format!(
            "invalid nonce length: expected {}, got {}",
            NONCE_SIZE,
            nonce_bytes.len()
        )));
    }

    let mut nonce_array = [0u8; NONCE_SIZE];
    nonce_array.copy_from_slice(&nonce_bytes);

    // Decrypt
    let data = decrypt(ciphertext, keys.data_key(), &nonce_array)?;

    // Verify checksum if provided
    if let Some(expected) = expected_checksum {
        let actual = compute_checksum(&data);
        if actual != expected {
            return Err(SyncError::DataCorruption(format!(
                "checksum mismatch: expected {}, got {}",
                expected, actual
            )));
        }
    }

    Ok(DecryptedBlob { data, blob_type })
}

/// Metadata for an encrypted blob (used for API requests).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BlobMetadata {
    /// Unique blob ID (assigned by server)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blob_id: Option<String>,
    /// Type of blob
    pub blob_type: BlobType,
    /// Start of time range covered by this blob
    pub time_start: String, // ISO 8601
    /// End of time range covered by this blob
    pub time_end: String, // ISO 8601
    /// Size in bytes
    pub size_bytes: u64,
    /// SHA-256 checksum of plaintext
    pub checksum: String,
    /// Encryption nonce (base64)
    pub encryption_nonce: String,
    /// Key version used for encryption
    pub key_version: u32,
    /// Search tokens (base64 encoded)
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub search_tokens: Vec<String>,
}

impl BlobMetadata {
    /// Create metadata from an encrypted blob.
    pub fn from_encrypted_blob(
        blob: &EncryptedBlob,
        time_start: &str,
        time_end: &str,
        key_version: u32,
    ) -> Self {
        Self {
            blob_id: None,
            blob_type: blob.blob_type,
            time_start: time_start.to_string(),
            time_end: time_end.to_string(),
            size_bytes: blob.ciphertext.len() as u64,
            checksum: blob.checksum.clone(),
            encryption_nonce: blob.nonce_base64(),
            key_version,
            search_tokens: blob.search_tokens_base64(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync::keys::NewUserKeyData;

    fn test_keys() -> SyncKeys {
        let (_key_data, keys) = NewUserKeyData::generate("test-password").unwrap();
        keys
    }

    #[test]
    fn test_encrypt_decrypt_blob() {
        let keys = test_keys();
        let data = b"Hello, World! This is test data for the blob.";

        let encrypted = encrypt_blob(data, BlobType::Ocr, &keys, Some("Hello World test")).unwrap();

        assert_ne!(encrypted.ciphertext, data);
        assert!(!encrypted.checksum.is_empty());
        assert!(!encrypted.search_tokens.is_empty());

        let decrypted = decrypt_blob(
            &encrypted.ciphertext,
            &encrypted.nonce_base64(),
            Some(&encrypted.checksum),
            BlobType::Ocr,
            &keys,
        )
        .unwrap();

        assert_eq!(decrypted.data, data);
        assert_eq!(decrypted.blob_type, BlobType::Ocr);
    }

    #[test]
    fn test_checksum_verification() {
        let keys = test_keys();
        let data = b"Some important data";

        let encrypted = encrypt_blob(data, BlobType::Transcripts, &keys, None).unwrap();

        // Correct checksum should work
        let result = decrypt_blob(
            &encrypted.ciphertext,
            &encrypted.nonce_base64(),
            Some(&encrypted.checksum),
            BlobType::Transcripts,
            &keys,
        );
        assert!(result.is_ok());

        // Wrong checksum should fail
        let result = decrypt_blob(
            &encrypted.ciphertext,
            &encrypted.nonce_base64(),
            Some("wrong-checksum"),
            BlobType::Transcripts,
            &keys,
        );
        assert!(result.is_err());
    }

    #[test]
    fn test_blob_metadata() {
        let keys = test_keys();
        let data = b"Test data";

        let encrypted = encrypt_blob(data, BlobType::Audio, &keys, None).unwrap();

        let metadata = BlobMetadata::from_encrypted_blob(
            &encrypted,
            "2024-01-01T00:00:00Z",
            "2024-01-01T01:00:00Z",
            1,
        );

        assert_eq!(metadata.blob_type, BlobType::Audio);
        assert_eq!(metadata.checksum, encrypted.checksum);
        assert_eq!(metadata.key_version, 1);
    }
}
