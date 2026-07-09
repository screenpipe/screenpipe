//! Key management for cloud sync encryption.
//!
//! This module handles the key hierarchy:
//! - Master Key: The root key, encrypted with password-derived key
//! - Data Key: Derived from master key, used to encrypt blobs
//! - Search Key: Derived from master key, used for HMAC search tokens

use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use serde::{Deserialize, Serialize};
use zeroize::Zeroize;

use super::crypto::{
    decrypt, derive_key_from_password, encrypt, generate_key, generate_nonce, generate_salt,
    KEY_SIZE, NONCE_SIZE, SALT_SIZE,
};
use super::error::{SyncError, SyncResult};

/// Domain separation constants for key derivation
const DATA_KEY_DOMAIN: &[u8] = b"screenpipe-sync-data-key-v1";
const SEARCH_KEY_DOMAIN: &[u8] = b"screenpipe-sync-search-key-v1";
const AUTO_SYNC_PASSWORD_DOMAIN: &str = "screenpipe-cloud-sync-v1";

/// Derive the auto-managed cloud sync password for an account.
///
/// This preserves the legacy web/desktop derivation (`sha256(account_id +
/// "screenpipe-cloud-sync-v1")`) so devices signed into the same account can
/// unlock the same cloud sync key without inventing a per-device random secret.
pub fn derive_auto_sync_password(account_id: &str) -> String {
    use sha2::{Digest, Sha256};

    let mut hasher = Sha256::new();
    hasher.update(account_id.as_bytes());
    hasher.update(AUTO_SYNC_PASSWORD_DOMAIN.as_bytes());
    hex::encode(hasher.finalize())
}

/// The complete set of keys needed for sync operations.
///
/// These keys are derived from the master key and held in memory
/// during sync operations. They are zeroized when dropped.
#[derive(Zeroize)]
#[zeroize(drop)]
pub struct SyncKeys {
    /// The decrypted master key (never leaves the device)
    master_key: [u8; KEY_SIZE],
    /// Key for encrypting/decrypting data blobs
    data_key: [u8; KEY_SIZE],
    /// Key for generating HMAC search tokens
    search_key: [u8; KEY_SIZE],
    /// Current key version (for rotation support)
    key_version: u32,
}

impl SyncKeys {
    /// Derive sub-keys from the master key.
    fn derive_subkeys(master_key: &[u8; KEY_SIZE]) -> ([u8; KEY_SIZE], [u8; KEY_SIZE]) {
        use hmac::{Hmac, Mac};
        use sha2::Sha256;

        type HmacSha256 = Hmac<Sha256>;

        // Derive data key
        let mut mac = <HmacSha256 as Mac>::new_from_slice(master_key).unwrap();
        mac.update(DATA_KEY_DOMAIN);
        let data_key_bytes = mac.finalize().into_bytes();
        let mut data_key = [0u8; KEY_SIZE];
        data_key.copy_from_slice(&data_key_bytes);

        // Derive search key
        let mut mac = <HmacSha256 as Mac>::new_from_slice(master_key).unwrap();
        mac.update(SEARCH_KEY_DOMAIN);
        let search_key_bytes = mac.finalize().into_bytes();
        let mut search_key = [0u8; KEY_SIZE];
        search_key.copy_from_slice(&search_key_bytes);

        (data_key, search_key)
    }

    /// Create SyncKeys from a decrypted master key.
    pub fn from_master_key(master_key: [u8; KEY_SIZE], key_version: u32) -> Self {
        let (data_key, search_key) = Self::derive_subkeys(&master_key);

        Self {
            master_key,
            data_key,
            search_key,
            key_version,
        }
    }

    /// Decrypt master key from server response and derive all keys.
    ///
    /// # Arguments
    /// * `password` - The user's password
    /// * `encrypted_master_key` - The encrypted master key from the server
    /// * `salt` - The salt used for password derivation
    /// * `nonce` - The nonce used for master key encryption
    /// * `key_version` - The key version number
    pub fn from_password(
        password: &str,
        encrypted_master_key: &[u8],
        salt: &[u8; SALT_SIZE],
        nonce: &[u8; NONCE_SIZE],
        key_version: u32,
    ) -> SyncResult<Self> {
        // Derive password key
        let password_key = derive_key_from_password(password, salt)?;

        // Decrypt master key
        let master_key_bytes = decrypt(encrypted_master_key, &password_key, nonce)?;

        if master_key_bytes.len() != KEY_SIZE {
            return Err(SyncError::Key(format!(
                "invalid master key length: expected {}, got {}",
                KEY_SIZE,
                master_key_bytes.len()
            )));
        }

        let mut master_key = [0u8; KEY_SIZE];
        master_key.copy_from_slice(&master_key_bytes);

        Ok(Self::from_master_key(master_key, key_version))
    }

    /// Get the data encryption key.
    pub fn data_key(&self) -> &[u8; KEY_SIZE] {
        &self.data_key
    }

    /// Get the search token key.
    pub fn search_key(&self) -> &[u8; KEY_SIZE] {
        &self.search_key
    }

    /// Get the current key version.
    pub fn key_version(&self) -> u32 {
        self.key_version
    }
}

/// Data needed to initialize sync for a new user.
///
/// This is generated on the client and sent to the server.
/// The server stores the encrypted master key but cannot decrypt it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewUserKeyData {
    /// Salt for password key derivation
    pub salt: String, // base64
    /// Encrypted master key (encrypted with password-derived key)
    pub encrypted_master_key: String, // base64
    /// Nonce used for master key encryption
    pub master_key_nonce: String, // base64
}

impl NewUserKeyData {
    /// Generate new key data for a new user.
    ///
    /// This creates a new random master key, encrypts it with a key
    /// derived from the user's password, and returns the data needed
    /// to store on the server.
    ///
    /// # Arguments
    /// * `password` - The user's chosen password
    ///
    /// # Returns
    /// A tuple of (NewUserKeyData, SyncKeys) - the data to send to server
    /// and the keys to use for encryption.
    pub fn generate(password: &str) -> SyncResult<(Self, SyncKeys)> {
        // Generate random salt and master key
        let salt = generate_salt();
        let master_key = generate_key();
        let nonce = generate_nonce();

        // Derive password key
        let password_key = derive_key_from_password(password, &salt)?;

        // Encrypt master key with password key
        let encrypted_master_key = encrypt(master_key.as_ref(), &password_key, &nonce)?;

        // Create the data to send to server
        let key_data = Self {
            salt: BASE64.encode(salt),
            encrypted_master_key: BASE64.encode(&encrypted_master_key),
            master_key_nonce: BASE64.encode(nonce),
        };

        // Create SyncKeys from the master key
        let mut master_key_array = [0u8; KEY_SIZE];
        master_key_array.copy_from_slice(master_key.as_ref());
        let sync_keys = SyncKeys::from_master_key(master_key_array, 1);

        Ok((key_data, sync_keys))
    }
}

/// Key data returned from the server for an existing user.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExistingUserKeyData {
    /// Salt for password key derivation
    pub salt: String, // base64
    /// Encrypted master key
    pub encrypted_master_key: String, // base64
    /// Nonce used for master key encryption
    pub master_key_nonce: String, // base64
    /// Key derivation algorithm (should be "argon2id")
    pub kdf_algorithm: String,
    /// Key derivation iterations
    pub kdf_iterations: u32,
    /// Key derivation memory (KB)
    pub kdf_memory: u32,
    /// Current key version
    pub key_version: u32,
}

impl ExistingUserKeyData {
    /// Decrypt and derive keys from this key data.
    pub fn derive_keys(&self, password: &str) -> SyncResult<SyncKeys> {
        // Decode base64 fields
        let salt_bytes = BASE64.decode(&self.salt)?;
        let encrypted_master_key = BASE64.decode(&self.encrypted_master_key)?;
        let nonce_bytes = BASE64.decode(&self.master_key_nonce)?;

        // Validate sizes
        if salt_bytes.len() != SALT_SIZE {
            return Err(SyncError::Key(format!(
                "invalid salt length: expected {}, got {}",
                SALT_SIZE,
                salt_bytes.len()
            )));
        }
        if nonce_bytes.len() != NONCE_SIZE {
            return Err(SyncError::Key(format!(
                "invalid nonce length: expected {}, got {}",
                NONCE_SIZE,
                nonce_bytes.len()
            )));
        }

        let mut salt = [0u8; SALT_SIZE];
        salt.copy_from_slice(&salt_bytes);

        let mut nonce = [0u8; NONCE_SIZE];
        nonce.copy_from_slice(&nonce_bytes);

        SyncKeys::from_password(
            password,
            &encrypted_master_key,
            &salt,
            &nonce,
            self.key_version,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_auto_sync_password_is_stable() {
        assert_eq!(
            derive_auto_sync_password("user_123"),
            derive_auto_sync_password("user_123")
        );
        assert_ne!(
            derive_auto_sync_password("user_123"),
            derive_auto_sync_password("user_456")
        );
        assert_eq!(derive_auto_sync_password("user_123").len(), 64);
    }

    #[test]
    fn test_new_user_key_generation() {
        let password = "test-password-123";

        let (key_data, keys) = NewUserKeyData::generate(password).unwrap();

        // Verify we can recover the keys with the same password
        let existing = ExistingUserKeyData {
            salt: key_data.salt.clone(),
            encrypted_master_key: key_data.encrypted_master_key.clone(),
            master_key_nonce: key_data.master_key_nonce.clone(),
            kdf_algorithm: "argon2id".to_string(),
            kdf_iterations: 3,
            kdf_memory: 65536,
            key_version: 1,
        };

        let recovered_keys = existing.derive_keys(password).unwrap();

        // Data keys should match
        assert_eq!(keys.data_key(), recovered_keys.data_key());
        assert_eq!(keys.search_key(), recovered_keys.search_key());
    }

    #[test]
    fn test_wrong_password_fails() {
        let password = "correct-password";
        let wrong_password = "wrong-password";

        let (key_data, _keys) = NewUserKeyData::generate(password).unwrap();

        let existing = ExistingUserKeyData {
            salt: key_data.salt,
            encrypted_master_key: key_data.encrypted_master_key,
            master_key_nonce: key_data.master_key_nonce,
            kdf_algorithm: "argon2id".to_string(),
            kdf_iterations: 3,
            kdf_memory: 65536,
            key_version: 1,
        };

        // Should fail with wrong password
        let result = existing.derive_keys(wrong_password);
        assert!(result.is_err());
    }

    #[test]
    fn test_subkeys_are_different() {
        let password = "test-password";
        let (_key_data, keys) = NewUserKeyData::generate(password).unwrap();

        // Data key and search key should be different
        assert_ne!(keys.data_key(), keys.search_key());
    }
}
