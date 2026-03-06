//! Sync API client for cloud sync operations.
//!
//! This module provides the HTTP client for communicating with the
//! Screenpipe cloud sync API.

use std::time::Duration;

use reqwest::{Client, StatusCode};
use serde::{Deserialize, Serialize};
use tracing::warn;

use super::blob::{BlobMetadata, BlobType};
use super::error::{SyncError, SyncResult};
use super::keys::{ExistingUserKeyData, NewUserKeyData, SyncKeys};

/// Default API base URL
const DEFAULT_API_URL: &str = "https://screenpi.pe/api/sync";

/// Configuration for the sync client.
#[derive(Debug, Clone)]
pub struct SyncClientConfig {
    /// Base URL for the sync API
    pub api_url: String,
    /// Authentication token (Clerk JWT)
    pub auth_token: String,
    /// Device ID (unique identifier for this device)
    pub device_id: String,
    /// Device name (user-friendly name)
    pub device_name: String,
    /// Device OS
    pub device_os: String,
    /// App version
    pub app_version: Option<String>,
}

impl SyncClientConfig {
    /// Create a new config with default API URL.
    pub fn new(
        auth_token: String,
        device_id: String,
        device_name: String,
        device_os: String,
    ) -> Self {
        Self {
            api_url: DEFAULT_API_URL.to_string(),
            auth_token,
            device_id,
            device_name,
            device_os,
            app_version: None,
        }
    }

    /// Set the API URL.
    pub fn with_api_url(mut self, url: String) -> Self {
        self.api_url = url;
        self
    }

    /// Set the app version.
    pub fn with_app_version(mut self, version: String) -> Self {
        self.app_version = Some(version);
        self
    }
}

/// Client for sync API operations.
pub struct SyncClient {
    config: SyncClientConfig,
    /// Short-timeout client for metadata/API calls
    http: Client,
    /// Long-timeout client for blob uploads/downloads
    http_transfer: Client,
}

/// Maximum retries for transient network errors.
const MAX_RETRIES: u32 = 3;
/// Initial backoff delay between retries.
const INITIAL_BACKOFF: Duration = Duration::from_secs(2);

impl SyncClient {
    /// Create a new sync client.
    pub fn new(config: SyncClientConfig) -> SyncResult<Self> {
        let http = Client::builder()
            .timeout(Duration::from_secs(30))
            .build()
            .map_err(|e| SyncError::Network(format!("failed to create HTTP client: {}", e)))?;

        let http_transfer = Client::builder()
            .timeout(Duration::from_secs(120))
            .build()
            .map_err(|e| SyncError::Network(format!("failed to create transfer client: {}", e)))?;

        Ok(Self {
            config,
            http,
            http_transfer,
        })
    }

    /// Get the device ID.
    pub fn device_id(&self) -> &str {
        &self.config.device_id
    }

    // =========================================================================
    // Init / Key Management
    // =========================================================================

    /// Initialize sync for a new user.
    ///
    /// This generates new encryption keys and registers them with the server.
    pub async fn init_new_user(&self, password: &str) -> SyncResult<SyncKeys> {
        let (key_data, keys) = NewUserKeyData::generate(password)?;

        let request = InitRequest {
            device_id: self.config.device_id.clone(),
            device_name: self.config.device_name.clone(),
            device_os: self.config.device_os.clone(),
            device_os_version: None,
            app_version: self.config.app_version.clone(),
            encrypted_master_key: Some(key_data.encrypted_master_key),
            master_key_nonce: Some(key_data.master_key_nonce),
            salt: Some(key_data.salt),
        };

        let response: InitResponse = self.post("/init", &request).await?;

        if !response.success {
            return Err(SyncError::Server(
                response.error.unwrap_or_else(|| "init failed".to_string()),
            ));
        }

        Ok(keys)
    }

    /// Initialize sync for an existing user.
    ///
    /// This fetches the encrypted master key and derives the sync keys.
    pub async fn init_existing_user(&self, password: &str) -> SyncResult<SyncKeys> {
        let request = InitRequest {
            device_id: self.config.device_id.clone(),
            device_name: self.config.device_name.clone(),
            device_os: self.config.device_os.clone(),
            device_os_version: None,
            app_version: self.config.app_version.clone(),
            encrypted_master_key: None,
            master_key_nonce: None,
            salt: None,
        };

        let response: InitResponse = self.post("/init", &request).await?;

        if !response.success {
            return Err(SyncError::Server(
                response.error.unwrap_or_else(|| "init failed".to_string()),
            ));
        }

        // For existing users, server returns the key data
        let key_data = ExistingUserKeyData {
            salt: response
                .salt
                .ok_or_else(|| SyncError::Key("missing salt".to_string()))?,
            encrypted_master_key: response
                .encrypted_master_key
                .ok_or_else(|| SyncError::Key("missing encrypted_master_key".to_string()))?,
            master_key_nonce: response
                .master_key_nonce
                .ok_or_else(|| SyncError::Key("missing master_key_nonce".to_string()))?,
            kdf_algorithm: response
                .kdf_algorithm
                .unwrap_or_else(|| "argon2id".to_string()),
            kdf_iterations: response.kdf_iterations.unwrap_or(3),
            kdf_memory: response.kdf_memory.unwrap_or(65536),
            key_version: response.key_version.unwrap_or(1),
        };

        key_data.derive_keys(password)
    }

    /// Initialize sync - automatically detects new vs existing user.
    pub async fn init(&self, password: &str) -> SyncResult<(SyncKeys, bool)> {
        // Try as existing user first
        let request = InitRequest {
            device_id: self.config.device_id.clone(),
            device_name: self.config.device_name.clone(),
            device_os: self.config.device_os.clone(),
            device_os_version: None,
            app_version: self.config.app_version.clone(),
            encrypted_master_key: None,
            master_key_nonce: None,
            salt: None,
        };

        let response: InitResponse = self.post("/init", &request).await?;

        if !response.success {
            let code = response.code.as_deref();
            if code == Some("NO_SUBSCRIPTION") {
                return Err(SyncError::NoSubscription);
            }
            return Err(SyncError::Server(
                response.error.unwrap_or_else(|| "init failed".to_string()),
            ));
        }

        let is_new_user = response.is_new_user.unwrap_or(false);

        if is_new_user {
            // New user - generate and upload keys
            let keys = self.init_new_user(password).await?;
            Ok((keys, true))
        } else {
            // Existing user - derive keys from server response
            let key_data = ExistingUserKeyData {
                salt: response
                    .salt
                    .ok_or_else(|| SyncError::Key("missing salt".to_string()))?,
                encrypted_master_key: response
                    .encrypted_master_key
                    .ok_or_else(|| SyncError::Key("missing encrypted_master_key".to_string()))?,
                master_key_nonce: response
                    .master_key_nonce
                    .ok_or_else(|| SyncError::Key("missing master_key_nonce".to_string()))?,
                kdf_algorithm: response
                    .kdf_algorithm
                    .unwrap_or_else(|| "argon2id".to_string()),
                kdf_iterations: response.kdf_iterations.unwrap_or(3),
                kdf_memory: response.kdf_memory.unwrap_or(65536),
                key_version: response.key_version.unwrap_or(1),
            };

            let keys = key_data.derive_keys(password)?;
            Ok((keys, false))
        }
    }

    // =========================================================================
    // Upload
    // =========================================================================

    /// Request a presigned URL for uploading a blob.
    pub async fn request_upload(&self, metadata: &BlobMetadata) -> SyncResult<UploadUrlResponse> {
        let request = UploadRequest {
            blob_type: metadata.blob_type,
            time_start: metadata.time_start.clone(),
            time_end: metadata.time_end.clone(),
            size_bytes: metadata.size_bytes,
            checksum: metadata.checksum.clone(),
            device_id: self.config.device_id.clone(),
            key_version: metadata.key_version,
            encryption_nonce: metadata.encryption_nonce.clone(),
            search_tokens: if metadata.search_tokens.is_empty() {
                None
            } else {
                Some(metadata.search_tokens.clone())
            },
        };

        let response: UploadResponse = self.post("/upload", &request).await?;

        if !response.success {
            let code = response.code.as_deref();
            if code == Some("QUOTA_EXCEEDED") {
                return Err(SyncError::QuotaExceeded(
                    response
                        .error
                        .unwrap_or_else(|| "quota exceeded".to_string()),
                ));
            }
            return Err(SyncError::Server(
                response
                    .error
                    .unwrap_or_else(|| "upload request failed".to_string()),
            ));
        }

        Ok(UploadUrlResponse {
            blob_id: response
                .blob_id
                .ok_or_else(|| SyncError::Server("missing blob_id".to_string()))?,
            upload_url: response
                .upload_url
                .ok_or_else(|| SyncError::Server("missing upload_url".to_string()))?,
            expires_in: response.expires_in.unwrap_or(300),
        })
    }

    /// Upload encrypted data using a Supabase signed upload URL.
    ///
    /// Supabase `createSignedUploadUrl` returns URLs that must be used with PUT
    /// and require the upload token in the URL path. The URL format is:
    /// `{supabaseUrl}/storage/v1/object/upload/sign/{bucket}/{path}?token={token}`
    pub async fn upload_to_s3(&self, upload_url: &str, data: &[u8]) -> SyncResult<()> {
        let mut last_err = None;
        for attempt in 0..MAX_RETRIES {
            if attempt > 0 {
                let backoff = INITIAL_BACKOFF * 2u32.pow(attempt - 1);
                warn!("upload retry {}/{} after {:?}", attempt + 1, MAX_RETRIES, backoff);
                tokio::time::sleep(backoff).await;
            }

            let result = self
                .http_transfer
                .put(upload_url)
                .header("Content-Type", "application/octet-stream")
                .header("x-upsert", "true")
                .body(data.to_vec())
                .send()
                .await;

            match result {
                Ok(response) => {
                    if response.status().is_success() {
                        return Ok(());
                    }
                    let status = response.status();
                    // Don't retry client errors (4xx)
                    if status.is_client_error() {
                        let body = response.text().await.unwrap_or_default();
                        return Err(SyncError::Server(format!(
                            "S3 upload failed with status: {} body: {}",
                            status, body
                        )));
                    }
                    let body = response.text().await.unwrap_or_default();
                    last_err = Some(SyncError::Server(format!(
                        "S3 upload failed with status: {} body: {}",
                        status, body
                    )));
                }
                Err(e) => {
                    last_err = Some(SyncError::Network(e.to_string()));
                }
            }
        }

        Err(last_err.unwrap_or_else(|| SyncError::Network("upload failed after retries".to_string())))
    }

    /// Mark an upload as completed.
    pub async fn complete_upload(&self, blob_id: &str) -> SyncResult<UploadCompleteResponse> {
        let request = UploadCompleteRequest {
            blob_id: blob_id.to_string(),
        };

        let response: UploadCompleteApiResponse = self.post("/upload/complete", &request).await?;

        if !response.success {
            return Err(SyncError::Server(
                response
                    .error
                    .unwrap_or_else(|| "complete upload failed".to_string()),
            ));
        }

        Ok(UploadCompleteResponse {
            storage_used: response.storage_used.unwrap_or(0),
            storage_limit: response.storage_limit.unwrap_or(0),
        })
    }

    // =========================================================================
    // Download
    // =========================================================================

    /// Get presigned download URLs for blobs.
    pub async fn get_download_urls(
        &self,
        request: DownloadRequest,
    ) -> SyncResult<Vec<DownloadBlob>> {
        let response: DownloadResponse = self.post("/download", &request).await?;

        if !response.success {
            return Err(SyncError::Server(
                response
                    .error
                    .unwrap_or_else(|| "download request failed".to_string()),
            ));
        }

        Ok(response.blobs)
    }

    /// Download encrypted data from S3.
    pub async fn download_from_s3(&self, download_url: &str) -> SyncResult<Vec<u8>> {
        let mut last_err = None;
        for attempt in 0..MAX_RETRIES {
            if attempt > 0 {
                let backoff = INITIAL_BACKOFF * 2u32.pow(attempt - 1);
                warn!("download retry {}/{} after {:?}", attempt + 1, MAX_RETRIES, backoff);
                tokio::time::sleep(backoff).await;
            }

            let result = self.http_transfer.get(download_url).send().await;

            match result {
                Ok(response) => {
                    if response.status().is_success() {
                        let bytes = response.bytes().await?;
                        return Ok(bytes.to_vec());
                    }
                    let status = response.status();
                    if status.is_client_error() {
                        let body = response.text().await.unwrap_or_default();
                        let body_preview = if body.len() > 500 { &body[..500] } else { &body };
                        return Err(SyncError::Server(format!(
                            "S3 download failed with status: {} body: {}",
                            status, body_preview
                        )));
                    }
                    let body = response.text().await.unwrap_or_default();
                    let body_preview = if body.len() > 500 { &body[..500] } else { &body };
                    last_err = Some(SyncError::Server(format!(
                        "S3 download failed with status: {} body: {}",
                        status, body_preview
                    )));
                }
                Err(e) => {
                    last_err = Some(SyncError::Network(e.to_string()));
                }
            }
        }

        Err(last_err.unwrap_or_else(|| SyncError::Network("download failed after retries".to_string())))
    }

    // =========================================================================
    // Search
    // =========================================================================

    /// Search for blobs by tokens.
    pub async fn search(&self, request: SearchRequest) -> SyncResult<SearchResponse> {
        let response: SearchApiResponse = self.post("/search", &request).await?;

        if !response.success {
            return Err(SyncError::Server(
                response
                    .error
                    .unwrap_or_else(|| "search failed".to_string()),
            ));
        }

        Ok(SearchResponse {
            matches: response.matches,
            total_matches: response.total_matches.unwrap_or(0),
        })
    }

    // =========================================================================
    // Status
    // =========================================================================

    /// Get sync status and quota information.
    pub async fn get_status(&self) -> SyncResult<SyncStatus> {
        let response: StatusResponse = self.get("/status").await?;

        if !response.success {
            return Err(SyncError::Server(
                response
                    .error
                    .unwrap_or_else(|| "status request failed".to_string()),
            ));
        }

        Ok(SyncStatus {
            quota: response
                .quota
                .ok_or_else(|| SyncError::Server("missing quota".to_string()))?,
            stats: response
                .stats
                .ok_or_else(|| SyncError::Server("missing stats".to_string()))?,
            storage_breakdown: response.storage_breakdown,
        })
    }

    // =========================================================================
    // Devices
    // =========================================================================

    /// List registered devices.
    pub async fn list_devices(&self) -> SyncResult<Vec<SyncDevice>> {
        let response: DevicesResponse = self.get("/devices").await?;

        if !response.success {
            return Err(SyncError::Server(
                response
                    .error
                    .unwrap_or_else(|| "list devices failed".to_string()),
            ));
        }

        Ok(response.devices)
    }

    /// Remove a device.
    pub async fn remove_device(&self, device_id: &str) -> SyncResult<()> {
        let url = format!("{}/devices?device_id={}", self.config.api_url, device_id);

        let response = self
            .http
            .delete(&url)
            .header(
                "Authorization",
                format!("Bearer {}", self.config.auth_token),
            )
            .send()
            .await?;

        if !response.status().is_success() {
            let error_body: ApiError = response.json().await.unwrap_or(ApiError {
                success: false,
                error: Some("unknown error".to_string()),
                code: None,
            });
            return Err(SyncError::Server(
                error_body
                    .error
                    .unwrap_or_else(|| "remove device failed".to_string()),
            ));
        }

        Ok(())
    }

    // =========================================================================
    // Data Management
    // =========================================================================

    /// Delete all cloud data for this user.
    pub async fn delete_all_data(&self) -> SyncResult<()> {
        let url = format!("{}/data", self.config.api_url);

        let response = self
            .http
            .delete(&url)
            .header(
                "Authorization",
                format!("Bearer {}", self.config.auth_token),
            )
            .send()
            .await?;

        if !response.status().is_success() {
            let error_body: ApiError = response.json().await.unwrap_or(ApiError {
                success: false,
                error: Some("unknown error".to_string()),
                code: None,
            });
            return Err(SyncError::Server(
                error_body
                    .error
                    .unwrap_or_else(|| "delete all data failed".to_string()),
            ));
        }

        Ok(())
    }

    // =========================================================================
    // HTTP Helpers
    // =========================================================================

    async fn post<T: Serialize, R: for<'de> Deserialize<'de>>(
        &self,
        path: &str,
        body: &T,
    ) -> SyncResult<R> {
        let url = format!("{}{}", self.config.api_url, path);
        let mut last_err = None;

        for attempt in 0..MAX_RETRIES {
            if attempt > 0 {
                let backoff = INITIAL_BACKOFF * 2u32.pow(attempt - 1);
                warn!("POST {} retry {}/{} after {:?}", path, attempt + 1, MAX_RETRIES, backoff);
                tokio::time::sleep(backoff).await;
            }

            match self
                .http
                .post(&url)
                .header(
                    "Authorization",
                    format!("Bearer {}", self.config.auth_token),
                )
                .header("X-Device-Id", &self.config.device_id)
                .json(body)
                .send()
                .await
            {
                Ok(response) => return self.handle_response(response).await,
                Err(e) => {
                    last_err = Some(SyncError::Network(e.to_string()));
                }
            }
        }

        Err(last_err.unwrap_or_else(|| SyncError::Network(format!("POST {} failed after retries", path))))
    }

    async fn get<R: for<'de> Deserialize<'de>>(&self, path: &str) -> SyncResult<R> {
        let url = format!("{}{}", self.config.api_url, path);
        let mut last_err = None;

        for attempt in 0..MAX_RETRIES {
            if attempt > 0 {
                let backoff = INITIAL_BACKOFF * 2u32.pow(attempt - 1);
                warn!("GET {} retry {}/{} after {:?}", path, attempt + 1, MAX_RETRIES, backoff);
                tokio::time::sleep(backoff).await;
            }

            match self
                .http
                .get(&url)
                .header(
                    "Authorization",
                    format!("Bearer {}", self.config.auth_token),
                )
                .header("X-Device-Id", &self.config.device_id)
                .send()
                .await
            {
                Ok(response) => return self.handle_response(response).await,
                Err(e) => {
                    last_err = Some(SyncError::Network(e.to_string()));
                }
            }
        }

        Err(last_err.unwrap_or_else(|| SyncError::Network(format!("GET {} failed after retries", path))))
    }

    async fn handle_response<R: for<'de> Deserialize<'de>>(
        &self,
        response: reqwest::Response,
    ) -> SyncResult<R> {
        let status = response.status();

        if status == StatusCode::UNAUTHORIZED {
            return Err(SyncError::Auth("unauthorized".to_string()));
        }

        if status == StatusCode::FORBIDDEN {
            // Could be quota or subscription issue
            let error_body: ApiError = response.json().await.unwrap_or(ApiError {
                success: false,
                error: Some("forbidden".to_string()),
                code: None,
            });

            if error_body.code.as_deref() == Some("NO_SUBSCRIPTION") {
                return Err(SyncError::NoSubscription);
            }
            if error_body.code.as_deref() == Some("QUOTA_EXCEEDED") {
                return Err(SyncError::QuotaExceeded(
                    error_body
                        .error
                        .unwrap_or_else(|| "quota exceeded".to_string()),
                ));
            }
            if error_body.code.as_deref() == Some("DEVICE_LIMIT_EXCEEDED") {
                return Err(SyncError::DeviceLimitExceeded);
            }

            return Err(SyncError::Server(
                error_body.error.unwrap_or_else(|| "forbidden".to_string()),
            ));
        }

        let body = response.text().await?;

        serde_json::from_str(&body).map_err(|e| {
            SyncError::Serialization(format!("failed to parse response: {} - body: {}", e, body))
        })
    }
}

// =============================================================================
// API Types
// =============================================================================

#[derive(Debug, Serialize)]
struct InitRequest {
    device_id: String,
    device_name: String,
    device_os: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    device_os_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    app_version: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    encrypted_master_key: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    master_key_nonce: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    salt: Option<String>,
}

#[derive(Debug, Deserialize)]
struct InitResponse {
    success: bool,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    code: Option<String>,
    #[serde(default)]
    is_new_user: Option<bool>,
    #[serde(default)]
    salt: Option<String>,
    #[serde(default)]
    encrypted_master_key: Option<String>,
    #[serde(default)]
    master_key_nonce: Option<String>,
    #[serde(default)]
    kdf_algorithm: Option<String>,
    #[serde(default)]
    kdf_iterations: Option<u32>,
    #[serde(default)]
    kdf_memory: Option<u32>,
    #[serde(default)]
    key_version: Option<u32>,
}

#[derive(Debug, Serialize)]
struct UploadRequest {
    blob_type: BlobType,
    time_start: String,
    time_end: String,
    size_bytes: u64,
    checksum: String,
    device_id: String,
    key_version: u32,
    encryption_nonce: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    search_tokens: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
struct UploadResponse {
    success: bool,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    code: Option<String>,
    #[serde(default)]
    blob_id: Option<String>,
    #[serde(default)]
    upload_url: Option<String>,
    #[serde(default)]
    expires_in: Option<u32>,
}

/// Response from upload URL request.
#[derive(Debug)]
pub struct UploadUrlResponse {
    /// The blob ID assigned by the server
    pub blob_id: String,
    /// Presigned S3 upload URL
    pub upload_url: String,
    /// Seconds until URL expires
    pub expires_in: u32,
}

#[derive(Debug, Serialize)]
struct UploadCompleteRequest {
    blob_id: String,
}

#[derive(Debug, Deserialize)]
struct UploadCompleteApiResponse {
    success: bool,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    storage_used: Option<u64>,
    #[serde(default)]
    storage_limit: Option<u64>,
}

/// Response from completing an upload.
#[derive(Debug)]
pub struct UploadCompleteResponse {
    /// Current storage used in bytes
    pub storage_used: u64,
    /// Storage limit in bytes
    pub storage_limit: u64,
}

/// Request for downloading blobs.
#[derive(Debug, Clone, Serialize)]
pub struct DownloadRequest {
    /// Specific blob IDs to download
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blob_ids: Option<Vec<String>>,
    /// Time range filter
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time_range: Option<TimeRange>,
    /// Blob types to include
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blob_types: Option<Vec<BlobType>>,
    /// Maximum number of blobs to return
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

/// Time range for filtering.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimeRange {
    /// Start of time range (ISO 8601)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub start: Option<String>,
    /// End of time range (ISO 8601)
    #[serde(skip_serializing_if = "Option::is_none")]
    pub end: Option<String>,
}

#[derive(Debug, Deserialize)]
struct DownloadResponse {
    success: bool,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    blobs: Vec<DownloadBlob>,
}

/// Information about a blob available for download.
#[derive(Debug, Clone, Deserialize)]
pub struct DownloadBlob {
    /// Blob ID
    pub blob_id: String,
    /// Blob type
    pub blob_type: BlobType,
    /// Presigned download URL
    pub download_url: String,
    /// Encryption nonce (base64)
    pub encryption_nonce: String,
    /// Key version used for encryption
    pub key_version: u32,
    /// Size in bytes
    pub size_bytes: u64,
    /// Checksum for verification
    pub checksum: String,
    /// Start of time range
    pub time_start: String,
    /// End of time range
    pub time_end: String,
}

/// Request for searching blobs.
#[derive(Debug, Clone, Serialize)]
pub struct SearchRequest {
    /// Search tokens (base64 encoded HMAC tokens)
    pub search_tokens: Vec<String>,
    /// Optional time range filter
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time_range: Option<TimeRange>,
    /// Optional blob type filter
    #[serde(skip_serializing_if = "Option::is_none")]
    pub blob_types: Option<Vec<BlobType>>,
    /// Maximum results
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct SearchApiResponse {
    success: bool,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    matches: Vec<SearchMatch>,
    #[serde(default)]
    total_matches: Option<u32>,
}

/// Search response.
#[derive(Debug)]
pub struct SearchResponse {
    /// Matching blobs
    pub matches: Vec<SearchMatch>,
    /// Total number of matches
    pub total_matches: u32,
}

/// A search result match.
#[derive(Debug, Clone, Deserialize)]
pub struct SearchMatch {
    /// Blob ID
    pub blob_id: String,
    /// Blob type
    pub blob_type: BlobType,
    /// Start of time range
    pub time_start: String,
    /// End of time range
    pub time_end: String,
    /// Number of matching tokens
    pub match_count: u32,
}

#[derive(Debug, Deserialize)]
struct StatusResponse {
    success: bool,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    quota: Option<SyncQuota>,
    #[serde(default)]
    stats: Option<SyncStats>,
    #[serde(default)]
    storage_breakdown: Option<StorageBreakdown>,
}

/// Sync status response.
#[derive(Debug)]
pub struct SyncStatus {
    /// Quota information
    pub quota: SyncQuota,
    /// Sync statistics
    pub stats: SyncStats,
    /// Storage breakdown by type
    pub storage_breakdown: Option<StorageBreakdown>,
}

/// Quota information.
#[derive(Debug, Clone, Deserialize)]
pub struct SyncQuota {
    /// Storage used in bytes
    pub storage_used: u64,
    /// Storage limit in bytes
    pub storage_limit: u64,
    /// Number of registered devices
    pub device_count: u32,
    /// Maximum allowed devices
    pub device_limit: u32,
    /// Whether sync is allowed
    pub can_sync: bool,
    /// Current sync tier
    pub sync_tier: Option<String>,
}

/// Sync statistics.
#[derive(Debug, Clone, Deserialize)]
pub struct SyncStats {
    /// Total number of blobs
    pub total_blobs: u32,
    /// Total bytes stored
    pub total_bytes: u64,
    /// Last sync timestamp
    pub last_sync_at: Option<String>,
    /// Oldest data timestamp
    pub oldest_data: Option<String>,
    /// Newest data timestamp
    pub newest_data: Option<String>,
}

/// Storage breakdown by blob type.
#[derive(Debug, Clone, Deserialize)]
pub struct StorageBreakdown {
    /// Bytes used by frames
    pub frames_bytes: u64,
    /// Bytes used by audio
    pub audio_bytes: u64,
    /// Bytes used by transcripts
    pub transcripts_bytes: u64,
    /// Bytes used by OCR
    pub ocr_bytes: u64,
}

#[derive(Debug, Deserialize)]
struct DevicesResponse {
    success: bool,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    devices: Vec<SyncDevice>,
}

/// A registered sync device.
#[derive(Debug, Clone, Deserialize)]
pub struct SyncDevice {
    /// Database ID
    pub id: String,
    /// Device ID
    pub device_id: String,
    /// User-friendly name
    pub device_name: Option<String>,
    /// Operating system
    pub device_os: String,
    /// Last sync timestamp
    pub last_sync_at: Option<String>,
    /// Created timestamp
    pub created_at: String,
}

#[derive(Debug, Deserialize)]
struct ApiError {
    #[allow(dead_code)]
    success: bool,
    #[serde(default)]
    error: Option<String>,
    #[serde(default)]
    code: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_config_builder() {
        let config = SyncClientConfig::new(
            "token".to_string(),
            "device-123".to_string(),
            "My MacBook".to_string(),
            "macos".to_string(),
        )
        .with_api_url("https://custom.api.com".to_string())
        .with_app_version("1.0.0".to_string());

        assert_eq!(config.api_url, "https://custom.api.com");
        assert_eq!(config.app_version, Some("1.0.0".to_string()));
    }

    #[test]
    fn test_download_request_serialization() {
        let request = DownloadRequest {
            blob_ids: Some(vec!["blob-1".to_string()]),
            time_range: Some(TimeRange {
                start: Some("2024-01-01T00:00:00Z".to_string()),
                end: None,
            }),
            blob_types: Some(vec![BlobType::Ocr, BlobType::Transcripts]),
            limit: Some(100),
        };

        let json = serde_json::to_string(&request).unwrap();
        assert!(json.contains("blob-1"));
        assert!(json.contains("ocr"));
    }

    #[test]
    fn test_search_request_serialization() {
        let request = SearchRequest {
            search_tokens: vec!["dG9rZW4x".to_string(), "dG9rZW4y".to_string()],
            time_range: None,
            blob_types: None,
            limit: Some(50),
        };

        let json = serde_json::to_string(&request).unwrap();
        assert!(json.contains("search_tokens"));
        assert!(json.contains("dG9rZW4x"));
    }
}
