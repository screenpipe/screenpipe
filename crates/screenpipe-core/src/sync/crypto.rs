//! Cryptographic primitives for cloud sync encryption.
//!
//! This module provides the core encryption functions:
//! - Argon2id for password-based key derivation
//! - ChaCha20-Poly1305 for authenticated encryption
//! - HMAC-SHA256 for searchable encryption tokens

use argon2::{Argon2, Params, Version};
use chacha20poly1305::{
    aead::{Aead, KeyInit as AeadKeyInit},
    ChaCha20Poly1305, Nonce,
};
use hmac::{Hmac, Mac};
use rand::RngCore;
use sha2::Sha256;
use zeroize::Zeroizing;

type HmacSha256 = Hmac<Sha256>;

use super::error::{SyncError, SyncResult};

/// Size of encryption keys in bytes (256 bits)
pub const KEY_SIZE: usize = 32;

/// Size of nonces for ChaCha20-Poly1305 (96 bits)
pub const NONCE_SIZE: usize = 12;

/// Size of salt for Argon2id (128 bits recommended minimum)
pub const SALT_SIZE: usize = 32;

/// Size of HMAC-SHA256 output
pub const HMAC_SIZE: usize = 32;

/// Argon2id parameters (OWASP recommended for password hashing)
/// - Memory: 64 MB
/// - Iterations: 3
/// - Parallelism: 4
const ARGON2_MEMORY_KB: u32 = 65536; // 64 MB
const ARGON2_ITERATIONS: u32 = 3;
const ARGON2_PARALLELISM: u32 = 4;

/// Generate a cryptographically secure random salt
pub fn generate_salt() -> [u8; SALT_SIZE] {
    let mut salt = [0u8; SALT_SIZE];
    rand::rng().fill_bytes(&mut salt);
    salt
}

/// Generate a cryptographically secure random nonce
pub fn generate_nonce() -> [u8; NONCE_SIZE] {
    let mut nonce = [0u8; NONCE_SIZE];
    rand::rng().fill_bytes(&mut nonce);
    nonce
}

/// Generate a cryptographically secure random key
pub fn generate_key() -> Zeroizing<[u8; KEY_SIZE]> {
    let mut key = Zeroizing::new([0u8; KEY_SIZE]);
    rand::rng().fill_bytes(key.as_mut());
    key
}

/// Derive a key from a password using Argon2id.
///
/// This is used to derive a key from the user's password, which then
/// decrypts the master key stored on the server.
///
/// # Arguments
/// * `password` - The user's password
/// * `salt` - A unique salt for this user (stored on server)
///
/// # Returns
/// A 256-bit derived key
pub fn derive_key_from_password(
    password: &str,
    salt: &[u8; SALT_SIZE],
) -> SyncResult<Zeroizing<[u8; KEY_SIZE]>> {
    let params = Params::new(
        ARGON2_MEMORY_KB,
        ARGON2_ITERATIONS,
        ARGON2_PARALLELISM,
        Some(KEY_SIZE),
    )
    .map_err(|e| SyncError::Crypto(format!("invalid argon2 params: {}", e)))?;

    let argon2 = Argon2::new(argon2::Algorithm::Argon2id, Version::V0x13, params);

    let mut derived_key = Zeroizing::new([0u8; KEY_SIZE]);
    argon2
        .hash_password_into(password.as_bytes(), salt, derived_key.as_mut())
        .map_err(|e| SyncError::Crypto(format!("key derivation failed: {}", e)))?;

    Ok(derived_key)
}

/// Encrypt data using ChaCha20-Poly1305.
///
/// This provides authenticated encryption - the ciphertext cannot be
/// modified without detection.
///
/// # Arguments
/// * `plaintext` - The data to encrypt
/// * `key` - A 256-bit encryption key
/// * `nonce` - A unique 96-bit nonce (MUST never be reused with the same key)
///
/// # Returns
/// The ciphertext with authentication tag appended
pub fn encrypt(
    plaintext: &[u8],
    key: &[u8; KEY_SIZE],
    nonce: &[u8; NONCE_SIZE],
) -> SyncResult<Vec<u8>> {
    let cipher = ChaCha20Poly1305::new_from_slice(key)
        .map_err(|e| SyncError::Crypto(format!("invalid key: {}", e)))?;

    let nonce = Nonce::from_slice(nonce);

    cipher
        .encrypt(nonce, plaintext)
        .map_err(|e| SyncError::Crypto(format!("encryption failed: {}", e)))
}

/// Decrypt data using ChaCha20-Poly1305.
///
/// This verifies the authentication tag and rejects tampered ciphertext.
///
/// # Arguments
/// * `ciphertext` - The encrypted data with authentication tag
/// * `key` - The 256-bit encryption key used for encryption
/// * `nonce` - The nonce used during encryption
///
/// # Returns
/// The decrypted plaintext, or an error if authentication fails
pub fn decrypt(
    ciphertext: &[u8],
    key: &[u8; KEY_SIZE],
    nonce: &[u8; NONCE_SIZE],
) -> SyncResult<Vec<u8>> {
    let cipher = ChaCha20Poly1305::new_from_slice(key)
        .map_err(|e| SyncError::Crypto(format!("invalid key: {}", e)))?;

    let nonce = Nonce::from_slice(nonce);

    cipher
        .decrypt(nonce, ciphertext)
        .map_err(|e| SyncError::Crypto(format!("decryption failed (authentication error): {}", e)))
}

/// Generate an HMAC-SHA256 token for searchable encryption.
///
/// This creates a deterministic, one-way token from a keyword. The same
/// keyword with the same key always produces the same token, enabling
/// server-side search without revealing the keyword.
///
/// # Arguments
/// * `keyword` - The keyword to tokenize (will be normalized to lowercase)
/// * `key` - The search key (derived from master key)
///
/// # Returns
/// A 256-bit HMAC token
pub fn generate_search_token(keyword: &str, key: &[u8; KEY_SIZE]) -> SyncResult<[u8; HMAC_SIZE]> {
    // Normalize: lowercase and trim
    let normalized = keyword.to_lowercase().trim().to_string();

    let mut mac = <HmacSha256 as Mac>::new_from_slice(key)
        .map_err(|e| SyncError::Crypto(format!("invalid hmac key: {}", e)))?;

    mac.update(normalized.as_bytes());

    let result = mac.finalize();
    let bytes = result.into_bytes();

    let mut token = [0u8; HMAC_SIZE];
    token.copy_from_slice(&bytes);

    Ok(token)
}

/// Generate search tokens from text by extracting and tokenizing keywords.
///
/// This extracts unique words from the text and generates HMAC tokens for each.
/// Used when uploading data to build the searchable index.
///
/// # Arguments
/// * `text` - The text to extract keywords from
/// * `key` - The search key
///
/// # Returns
/// A list of unique HMAC tokens
pub fn generate_search_tokens_from_text(
    text: &str,
    key: &[u8; KEY_SIZE],
) -> SyncResult<Vec<[u8; HMAC_SIZE]>> {
    let keywords = extract_keywords(text);
    let mut tokens = Vec::with_capacity(keywords.len());

    for keyword in keywords {
        tokens.push(generate_search_token(&keyword, key)?);
    }

    Ok(tokens)
}

/// Extract searchable keywords from text.
///
/// This performs basic tokenization:
/// - Split on whitespace and punctuation
/// - Normalize to lowercase
/// - Filter out very short words (< 3 chars)
/// - Deduplicate
fn extract_keywords(text: &str) -> Vec<String> {
    let mut keywords: Vec<String> = text
        .split(|c: char| c.is_whitespace() || c.is_ascii_punctuation())
        .map(|s| s.to_lowercase())
        .filter(|s| s.len() >= 3) // Skip very short words
        .collect();

    keywords.sort();
    keywords.dedup();
    keywords
}

/// Compute SHA-256 checksum of data.
///
/// Used to verify data integrity after decryption.
pub fn compute_checksum(data: &[u8]) -> String {
    use sha2::{Digest, Sha256};
    let mut hasher = Sha256::new();
    hasher.update(data);
    let result = hasher.finalize();
    hex::encode(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_key_derivation() {
        let password = "test-password-123";
        let salt = generate_salt();

        let key1 = derive_key_from_password(password, &salt).unwrap();
        let key2 = derive_key_from_password(password, &salt).unwrap();

        // Same password + salt should produce same key
        assert_eq!(key1.as_ref(), key2.as_ref());

        // Different salt should produce different key
        let different_salt = generate_salt();
        let key3 = derive_key_from_password(password, &different_salt).unwrap();
        assert_ne!(key1.as_ref(), key3.as_ref());
    }

    #[test]
    fn test_encrypt_decrypt() {
        let key = generate_key();
        let nonce = generate_nonce();
        let plaintext = b"Hello, World! This is a test message.";

        let ciphertext = encrypt(plaintext, &key, &nonce).unwrap();
        assert_ne!(ciphertext, plaintext);

        let decrypted = decrypt(&ciphertext, &key, &nonce).unwrap();
        assert_eq!(decrypted, plaintext);
    }

    #[test]
    fn test_tampered_ciphertext_fails() {
        let key = generate_key();
        let nonce = generate_nonce();
        let plaintext = b"Secret message";

        let mut ciphertext = encrypt(plaintext, &key, &nonce).unwrap();

        // Tamper with the ciphertext
        ciphertext[0] ^= 0xFF;

        // Decryption should fail
        let result = decrypt(&ciphertext, &key, &nonce);
        assert!(result.is_err());
    }

    #[test]
    fn test_search_tokens() {
        let key = generate_key();

        // Same keyword produces same token
        let token1 = generate_search_token("meeting", &key).unwrap();
        let token2 = generate_search_token("meeting", &key).unwrap();
        assert_eq!(token1, token2);

        // Case insensitive
        let token3 = generate_search_token("MEETING", &key).unwrap();
        assert_eq!(token1, token3);

        // Different keyword produces different token
        let token4 = generate_search_token("project", &key).unwrap();
        assert_ne!(token1, token4);
    }

    #[test]
    fn test_extract_keywords() {
        let text = "Hello World! This is a test. Testing, one, two, three.";
        let keywords = extract_keywords(text);

        assert!(keywords.contains(&"hello".to_string()));
        assert!(keywords.contains(&"world".to_string()));
        assert!(keywords.contains(&"test".to_string()));
        assert!(keywords.contains(&"testing".to_string()));

        // Short words should be filtered
        assert!(!keywords.contains(&"is".to_string()));
        assert!(!keywords.contains(&"a".to_string()));
    }
}
