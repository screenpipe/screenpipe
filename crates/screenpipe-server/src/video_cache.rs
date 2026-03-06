use anyhow::Result;
use bincode;
use chrono::{DateTime, Duration, Utc};
use dirs::cache_dir;
use screenpipe_core::find_ffmpeg_path;
use screenpipe_db::{DatabaseManager, FrameData, OCREntry};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::SystemTime;
use tokio::fs;
use tokio::process::Command;
use tokio::sync::mpsc::Sender;
use tokio::sync::{mpsc, oneshot};
use tracing::{debug, error};

type FrameChannel = mpsc::Sender<TimeSeriesFrame>;

#[derive(Debug, Clone)]
pub struct TimeSeriesFrame {
    pub timestamp: DateTime<Utc>,
    pub frame_data: Vec<DeviceFrame>,
    pub offset_index: i64,
    pub fps: f64,
    pub error: Option<String>,
}

#[derive(Debug, Clone)]
pub struct DeviceFrame {
    pub device_id: String,
    pub frame_id: i64,
    pub image_data: Vec<u8>,
    pub metadata: FrameMetadata,
    pub audio_entries: Vec<AudioEntry>,
    pub machine_id: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AudioEntry {
    pub transcription: String,
    pub device_name: String,
    pub is_input: bool,
    pub audio_file_path: String,
    pub duration_secs: f64,
    pub audio_chunk_id: i64,
    pub speaker_id: Option<i64>,
    pub speaker_name: Option<String>,
    pub start_time: Option<f64>,
    pub end_time: Option<f64>,
}

impl From<screenpipe_db::AudioEntry> for AudioEntry {
    fn from(db_entry: screenpipe_db::AudioEntry) -> Self {
        Self {
            transcription: db_entry.transcription,
            device_name: db_entry.device_name,
            is_input: db_entry.is_input,
            audio_file_path: db_entry.audio_file_path,
            duration_secs: db_entry.duration_secs,
            audio_chunk_id: db_entry.audio_chunk_id,
            speaker_id: db_entry.speaker_id,
            speaker_name: db_entry.speaker_name,
            start_time: db_entry.start_time,
            end_time: db_entry.end_time,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FrameMetadata {
    pub file_path: String,
    pub app_name: String,
    pub window_name: String,
    pub transcription: String,
    pub ocr_text: String,
    pub browser_url: Option<String>,
}

type GetFrameResponse =
    oneshot::Sender<Result<Option<(Vec<u8>, FrameMetadata, (DateTime<Utc>, String))>>>;

#[derive(Debug)]
enum CacheMessage {
    Store {
        cache_key: String,
        frame_data: Vec<u8>,
        device_data: OCREntry,
        audio_entries: Vec<AudioEntry>,
        response: oneshot::Sender<Result<()>>,
    },
    Get {
        cache_key: String,
        response: GetFrameResponse,
    },
}

#[derive(Debug, Serialize, Deserialize)]
struct CachedFrame {
    #[serde(with = "chrono::serde::ts_microseconds")]
    timestamp: DateTime<Utc>,
    device_id: String,
    checksum: String,
    metadata: FrameMetadata,
    frame_size: u64,
    compression: CompressionType,
    source_video: String,
    #[serde(with = "chrono::serde::ts_microseconds")]
    cached_at: DateTime<Utc>,
    audio_entries: Vec<AudioEntry>,
}

#[derive(Debug, Serialize, Deserialize)]
enum CompressionType {
    Jpeg { quality: u8 },
}

#[derive(Debug)]
struct CacheEntry {
    frame: CachedFrame,
    path: PathBuf,
    #[allow(dead_code)]
    last_accessed: SystemTime,
}

#[derive(Debug, Clone)]
struct CacheConfig {
    cache_dir: PathBuf,
    max_cache_size_gb: f64,
    frame_retention_days: u64,
    compression_quality: u8,
}

impl Default for CacheConfig {
    fn default() -> Self {
        Self {
            cache_dir: PathBuf::from("frame_cache"),
            max_cache_size_gb: 10.0,
            frame_retention_days: 7,
            compression_quality: 35,
        }
    }
}

struct FrameDiskCache {
    config: CacheConfig,
    entries: BTreeMap<(DateTime<Utc>, String), CacheEntry>,
    total_size: u64,
    index_path: PathBuf,
}

impl FrameDiskCache {
    async fn new(config: CacheConfig) -> Result<Self> {
        let cache_dir = &config.cache_dir;
        let index_path = cache_dir.join("cache_index.bin");

        fs::create_dir_all(cache_dir).await?;

        let mut cache = Self {
            config,
            entries: BTreeMap::new(),
            total_size: 0,
            index_path,
        };

        if cache.index_path.exists() {
            if let Err(e) = cache.load_index().await {
                debug!("could not load existing cache index: {}", e);
                cache.entries.clear();
                cache.total_size = 0;
            }
        } else {
            cache.save_index().await?;
        }

        Ok(cache)
    }

    async fn load_index(&mut self) -> Result<()> {
        match fs::read(&self.index_path).await {
            Ok(data) if !data.is_empty() => match bincode::deserialize::<Vec<CachedFrame>>(&data) {
                Ok(frames) => {
                    for frame in frames {
                        let path = self.get_frame_path(&frame.timestamp, &frame.device_id);
                        if let Ok(metadata) = fs::metadata(&path).await {
                            self.entries.insert(
                                (frame.timestamp, frame.device_id.clone()),
                                CacheEntry {
                                    frame,
                                    path,
                                    last_accessed: metadata.accessed()?,
                                },
                            );
                            self.total_size += metadata.len();
                        }
                    }
                    debug!("loaded {} cached frames", self.entries.len());
                }
                Err(e) => error!("failed to deserialize cache index: {}", e),
            },
            Ok(_) => debug!("cache index is empty, starting fresh"),
            Err(e) => error!("failed to read cache index: {}", e),
        }
        Ok(())
    }

    async fn save_index(&self) -> Result<()> {
        let frames: Vec<_> = self.entries.values().map(|entry| &entry.frame).collect();
        let temp_path = self.index_path.with_extension("tmp");
        let encoded = if frames.is_empty() {
            bincode::serialize(&Vec::<CachedFrame>::new())?
        } else {
            bincode::serialize(&frames)?
        };

        fs::write(&temp_path, encoded).await?;
        fs::rename(&temp_path, &self.index_path).await?;
        Ok(())
    }

    async fn store_frame(
        &mut self,
        cache_key: &str,
        frame_data: &[u8],
        device_data: OCREntry,
        audio_entries: &[AudioEntry],
    ) -> Result<()> {
        debug!("storing frame with cache key: {}", cache_key);
        let (timestamp_str, device_id) = cache_key
            .split_once("||")
            .ok_or_else(|| anyhow::anyhow!("invalid cache key format"))?;

        let timestamp = parse_timestamp(timestamp_str)?;

        let frame_path = self.get_frame_path(&timestamp, device_id);

        if let Some(parent) = frame_path.parent() {
            fs::create_dir_all(parent).await?;
        }

        let mut hasher = Sha256::new();
        hasher.update(frame_data);
        let checksum = format!("{:x}", hasher.finalize());

        let cached_frame = CachedFrame {
            timestamp,
            device_id: device_id.to_string(),
            checksum,
            metadata: FrameMetadata {
                file_path: device_data.video_file_path.clone(),
                app_name: device_data.app_name.clone(),
                window_name: device_data.window_name.clone(),
                transcription: audio_entries
                    .iter()
                    .map(|a| a.transcription.clone())
                    .collect::<Vec<_>>()
                    .join(" "),
                ocr_text: device_data.text.clone(),
                browser_url: device_data.browser_url.clone(),
            },
            frame_size: frame_data.len() as u64,
            compression: CompressionType::Jpeg {
                quality: self.config.compression_quality,
            },
            source_video: device_data.video_file_path,
            cached_at: Utc::now(),
            audio_entries: audio_entries.to_vec(),
        };

        fs::write(&frame_path, frame_data).await?;

        self.entries.insert(
            (timestamp, device_id.to_string()),
            CacheEntry {
                frame: cached_frame,
                path: frame_path,
                last_accessed: SystemTime::now(),
            },
        );

        self.total_size += frame_data.len() as u64;
        self.save_index().await?;

        Ok(())
    }

    async fn get_frame_data(
        &self,
        cache_key: &str,
    ) -> Result<Option<(Vec<u8>, FrameMetadata, (DateTime<Utc>, String))>> {
        let (timestamp_str, device_id) = match cache_key.split_once("||") {
            Some(parts) => parts,
            None => return Ok(None),
        };

        debug!("cache lookup for key: {}", cache_key);

        let timestamp = match parse_timestamp(timestamp_str) {
            Ok(ts) => ts,
            Err(e) => {
                debug!("failed to parse timestamp {}: {}", timestamp_str, e);
                return Ok(None);
            }
        };

        // First check if we have the entry before reading the file
        if let Some(entry) = self.entries.get(&(timestamp, device_id.to_string())) {
            let frame_path = &entry.path;

            // Only verify checksum periodically (e.g., every 100th access) or if file size changed
            let metadata = match fs::metadata(&frame_path).await {
                Ok(m) => m,
                Err(_) => return Ok(None),
            };

            let should_verify =
                metadata.len() != entry.frame.frame_size || fastrand::u32(0..100) == 0; // Random periodic verification

            if should_verify {
                debug!("verifying checksum for cached frame");
                let frame_data = fs::read(&frame_path).await?;
                let mut hasher = Sha256::new();
                hasher.update(&frame_data);
                let checksum = format!("{:x}", hasher.finalize());

                if checksum != entry.frame.checksum {
                    debug!("checksum mismatch for frame at {}:{}", timestamp, device_id);
                    return Ok(None);
                }

                Ok(Some((
                    frame_data,
                    entry.frame.metadata.clone(),
                    (timestamp, device_id.to_string()),
                )))
            } else {
                // Fast path - skip checksum verification
                let frame_data = fs::read(&frame_path).await?;
                Ok(Some((
                    frame_data,
                    entry.frame.metadata.clone(),
                    (timestamp, device_id.to_string()),
                )))
            }
        } else {
            debug!("cache miss - no entry in index for frame");
            Ok(None)
        }
    }

    fn get_frame_path(&self, timestamp: &DateTime<Utc>, device_id: &str) -> PathBuf {
        self.config.cache_dir.join(format!(
            "{}_{}.cache",
            timestamp.timestamp_micros(),
            device_id.replace(['/', '\\', ':'], "_")
        ))
    }

    async fn cleanup(&mut self) -> Result<()> {
        debug!("starting cache cleanup");

        // Calculate size limit in bytes
        let max_size_bytes = (self.config.max_cache_size_gb * 1024.0 * 1024.0 * 1024.0) as u64;

        // Calculate retention cutoff
        let retention_cutoff = Utc::now() - Duration::days(self.config.frame_retention_days as i64);

        let mut frames_to_remove = Vec::new();

        // Identify frames to remove based on age and total size
        for &(timestamp, ref device_id) in self.entries.keys() {
            if timestamp < retention_cutoff {
                frames_to_remove.push((timestamp, device_id.clone()));
                continue;
            }

            // If we're still over size limit, remove oldest frames
            if self.total_size > max_size_bytes {
                frames_to_remove.push((timestamp, device_id.clone()));
            }
        }

        // Remove identified frames
        for (timestamp, device_id) in frames_to_remove {
            if let Some(entry) = self.entries.remove(&(timestamp, device_id)) {
                self.total_size = self.total_size.saturating_sub(entry.frame.frame_size);
                if let Err(e) = fs::remove_file(&entry.path).await {
                    debug!("failed to remove cached frame: {}", e);
                }
            }
        }

        // Save updated index
        self.save_index().await?;

        debug!(
            "cleanup complete - current cache size: {:.2} GB",
            self.total_size as f64 / (1024.0 * 1024.0 * 1024.0)
        );

        Ok(())
    }
}

async fn run_cache_manager(mut cache: FrameDiskCache, mut rx: mpsc::Receiver<CacheMessage>) {
    let mut cleanup_interval = tokio::time::interval(tokio::time::Duration::from_secs(3600)); // Hourly cleanup

    loop {
        tokio::select! {
            Some(msg) = rx.recv() => {
                match msg {
                    CacheMessage::Store {
                        cache_key,
                        frame_data,
                        device_data,
                        audio_entries,
                        response,
                    } => {
                        let result = cache
                            .store_frame(&cache_key, &frame_data, device_data, &audio_entries)
                            .await;
                        let _ = response.send(result);
                    }
                    CacheMessage::Get {
                        cache_key,
                        response,
                    } => {
                        let result = cache.get_frame_data(&cache_key).await;
                        let _ = response.send(result);
                    }
                }
            }
            _ = cleanup_interval.tick() => {
                if let Err(e) = cache.cleanup().await {
                    debug!("cache cleanup failed: {}", e);
                }
            }
            else => break,
        }
    }
}

#[derive(Clone)]
pub struct FrameCache {
    pub screenpipe_dir: PathBuf,
    cache_tx: mpsc::Sender<CacheMessage>,
    db: Arc<DatabaseManager>,
}

impl FrameCache {
    pub async fn new(screenpipe_dir: PathBuf, db: Arc<DatabaseManager>) -> Result<Self> {
        let cache_config = CacheConfig {
            cache_dir: cache_dir().unwrap().join("screenpipe").join("frames"),
            ..Default::default()
        };

        fs::create_dir_all(&cache_config.cache_dir).await?;

        let (cache_tx, cache_rx) = mpsc::channel(100);
        let disk_cache = FrameDiskCache::new(cache_config).await?;

        tokio::spawn(run_cache_manager(disk_cache, cache_rx));

        Ok(Self {
            screenpipe_dir,
            cache_tx,
            db,
        })
    }

    async fn extract_frames_batch(
        &self,
        start_time: DateTime<Utc>,
        end_time: DateTime<Utc>,
        frame_tx: FrameChannel,
        descending: bool,
    ) -> Result<()> {
        let mut extraction_queue = HashMap::new();
        let mut total_frames = 0;

        debug!(
            "extracting frames for time range: {} to {}",
            start_time, end_time
        );

        let mut chunks = self.db.find_video_chunks(start_time, end_time).await?;
        // Sort by timestamp to ensure consistent ordering
        if descending {
            // For descending, sort in reverse chronological order
            chunks
                .frames
                .sort_by_key(|a| std::cmp::Reverse((a.timestamp, a.offset_index)));
        } else {
            // For ascending, sort in chronological order (default behavior)
            chunks.frames.sort_by_key(|a| (a.timestamp, a.offset_index));
        }

        debug!("found {} chunks to process", chunks.frames.len());

        // First pass: process all cache hits
        for chunk in &chunks.frames {
            let mut timeseries_frame = TimeSeriesFrame {
                timestamp: chunk.timestamp,
                frame_data: Vec::new(),
                offset_index: chunk.offset_index,
                fps: chunk.fps,
                error: None,
            };

            for device_data in &chunk.ocr_entries {
                let cache_key = format!("{}||{}", chunk.timestamp, device_data.device_name);
                debug!("checking cache for key: {}", cache_key);

                let (response_tx, response_rx) = oneshot::channel();
                self.cache_tx
                    .send(CacheMessage::Get {
                        cache_key: cache_key.clone(),
                        response: response_tx,
                    })
                    .await?;

                match response_rx.await? {
                    Ok(Some((frame_data, metadata, _))) => {
                        debug!("cache hit for {}", cache_key);
                        timeseries_frame.frame_data.push(DeviceFrame {
                            frame_id: chunk.frame_id,
                            device_id: device_data.device_name.clone(),
                            image_data: frame_data,
                            metadata,
                            audio_entries: chunk
                                .audio_entries
                                .iter()
                                .map(|a| AudioEntry {
                                    transcription: a.transcription.clone(),
                                    device_name: a.device_name.clone(),
                                    is_input: a.is_input,
                                    audio_file_path: a.audio_file_path.clone(),
                                    duration_secs: a.duration_secs,
                                    audio_chunk_id: a.audio_chunk_id,
                                    speaker_id: a.speaker_id,
                                    speaker_name: a.speaker_name.clone(),
                                    start_time: a.start_time,
                                    end_time: a.end_time,
                                })
                                .collect(),
                            machine_id: chunk.machine_id.clone(),
                        });
                    }
                    _ => {
                        debug!("cache miss for {}", cache_key);
                        extraction_queue
                            .entry(device_data.video_file_path.clone())
                            .or_insert_with(Vec::new)
                            .push((chunk.clone(), device_data.clone()));
                    }
                }
            }

            if !timeseries_frame.frame_data.is_empty() {
                total_frames += timeseries_frame.frame_data.len();
                debug!(
                    "sending cached frame batch with {} devices",
                    timeseries_frame.frame_data.len()
                );
                frame_tx.send(timeseries_frame).await?;
            }
        }

        // Second pass: handle cache misses
        if !extraction_queue.is_empty() {
            let ffmpeg = find_ffmpeg_path().ok_or_else(|| anyhow::anyhow!("ffmpeg not found"))?;

            for (file_path, tasks) in extraction_queue {
                debug!("extracting {} frames from {}", tasks.len(), file_path);
                let extracted = extract_frame(
                    ffmpeg.clone(),
                    file_path,
                    tasks,
                    frame_tx.clone(),
                    self.cache_tx.clone(),
                )
                .await?;
                total_frames += extracted;
            }
        }

        debug!("total frames processed: {}", total_frames);
        Ok(())
    }

    pub async fn get_frames(
        &self,
        timestamp: DateTime<Utc>,
        duration_minutes: i64,
        frame_tx: Sender<TimeSeriesFrame>,
        descending: bool,
    ) -> Result<()> {
        let start = timestamp - Duration::minutes(duration_minutes / 2);
        let end = timestamp + Duration::minutes(duration_minutes / 2);

        let (extract_tx, mut extract_rx) = mpsc::channel(100);

        let mut streamer = OrderedFrameStreamer::new(frame_tx, Duration::seconds(60), descending);

        // Spawn extraction task
        let mut extraction_handle = {
            let cache_clone = self.clone();
            tokio::spawn(async move {
                let result = cache_clone
                    .extract_frames_batch(start, end, extract_tx, descending)
                    .await;
                debug!("extraction task completed: {:?}", result.is_ok());
                result
            })
        };

        let timeout_duration = tokio::time::Duration::from_secs(10 * duration_minutes as u64);
        let result = tokio::time::timeout(timeout_duration, async {
            loop {
                tokio::select! {
                    maybe_frame = extract_rx.recv() => {
                        match maybe_frame {
                            Some(frame) => {
                                if let Err(e) = streamer.push(frame).await {
                                    debug!("failed to push frame: {}", e);
                                    break;
                                }
                            }
                            None => {
                                debug!("extraction channel closed");
                                break;
                            }
                        }
                    }
                    result = &mut extraction_handle => {
                        match result {
                            Ok(Ok(())) => debug!("extraction completed successfully"),
                            Ok(Err(e)) => debug!("extraction failed: {}", e),
                            Err(e) => debug!("extraction task panicked: {}", e),
                        }
                        break;
                    }
                }
            }

            if let Err(e) = streamer.finish().await {
                debug!("error during final flush: {}", e);
            }
        })
        .await;

        match result {
            Ok(_) => Ok(()),
            Err(_) => {
                debug!(
                    "frame extraction timed out after {} seconds",
                    timeout_duration.as_secs()
                );
                Ok(())
            }
        }
    }
}

async fn extract_frame(
    ffmpeg: PathBuf,
    video_file_path: String,
    tasks: Vec<(FrameData, OCREntry)>,
    frame_tx: FrameChannel,
    cache_tx: mpsc::Sender<CacheMessage>,
) -> Result<usize> {
    // Skip empty/corrupted video files early to avoid pointless ffmpeg calls
    if let Ok(metadata) = tokio::fs::metadata(&video_file_path).await {
        if metadata.len() == 0 {
            debug!("skipping empty video file (0 bytes): {}", video_file_path);
            return Ok(0);
        }
    }

    if !is_video_file_complete(&ffmpeg, &video_file_path).await? {
        debug!("skipping incomplete video file: {}", video_file_path);
        return Ok(0);
    }

    // Get source FPS from video metadata
    let source_fps = match get_video_fps(&ffmpeg, &video_file_path).await {
        Ok(fps) => fps,
        Err(e) => {
            error!("failed to get video fps, using default 1fps: {}", e);
            1.0
        }
    };

    let temp_dir = tempfile::tempdir()?;
    let output_pattern = temp_dir.path().join("frame%d.jpg");

    // Reduce frame rate even further for older content
    let frame_interval = if is_older_than_24h(&tasks[0].0.timestamp) {
        (source_fps / 0.05).round() as i64 // 1 frame every 20 seconds for older content
    } else {
        (source_fps / 0.1).round() as i64 // 1 frame every 10 seconds for recent content
    };

    debug!(
        "extracting frames with interval {} (source: {}fps, target: {}fps)",
        frame_interval, source_fps, 0.1
    );

    // Calculate which frames to extract
    let frame_positions: Vec<String> = tasks
        .iter()
        .filter_map(|(frame, _)| {
            // Only select frames that align with our target FPS
            if frame.offset_index % frame_interval == 0 {
                Some(frame.offset_index.to_string())
            } else {
                None
            }
        })
        .collect();

    if frame_positions.is_empty() {
        debug!("no frames to extract after applying fps filter");
        return Ok(0);
    }

    // Join frame numbers with commas and wrap in select filter
    let select_filter = format!("select='eq(n,{})'", frame_positions.join(")+eq(n,"));

    let mut cmd = Command::new(&ffmpeg);
    cmd.args([
        "-i",
        &video_file_path,
        "-vf",
        &format!("{},format=yuv420p,scale=iw*0.8:ih*0.8", select_filter),
        "-strict",
        "unofficial",
        "-c:v",
        "mjpeg",
        "-q:v",
        "12",
        "-qmin",
        "12",
        "-qmax",
        "15",
        "-vsync",
        "0",
        "-threads",
        "1",         // Limit to single thread
        "-cpu-used", // Faster encoding
        "4",
        output_pattern.to_str().unwrap(),
    ]);

    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    debug!("running ffmpeg command: {:?}", cmd);

    let output = cmd.output().await?;
    if !output.status.success() {
        error!("ffmpeg error: {}", String::from_utf8_lossy(&output.stderr));
        return Ok(0);
    }

    let mut processed = 0;
    let mut entries = tokio::fs::read_dir(temp_dir.path()).await?;
    let mut all_frames = Vec::new();

    while let Some(entry) = entries.next_entry().await? {
        let frame_data = tokio::fs::read(entry.path()).await?;
        all_frames.push(frame_data);
    }

    debug!("extracted {} frames from video", all_frames.len());

    for (task_index, (chunk, device_data)) in tasks.iter().enumerate() {
        if task_index >= all_frames.len() {
            debug!("warning: ran out of frames at index {}", task_index);
            break;
        }

        let (frame, _) = &tasks[task_index];
        let frame_data = &all_frames[task_index];
        let cache_key = format!("{}||{}", chunk.timestamp, device_data.device_name);
        debug!("processing frame {} with key {}", task_index, cache_key);

        // Store in cache first
        let (response_tx, response_rx) = oneshot::channel();
        cache_tx
            .send(CacheMessage::Store {
                cache_key: cache_key.clone(),
                frame_data: frame_data.clone(),
                device_data: device_data.clone(),
                audio_entries: chunk
                    .audio_entries
                    .clone()
                    .into_iter()
                    .map(Into::into)
                    .collect(),
                response: response_tx,
            })
            .await?;

        response_rx.await??;

        // Then send the frame
        frame_tx
            .send(TimeSeriesFrame {
                error: None,
                timestamp: chunk.timestamp,
                offset_index: chunk.offset_index,
                fps: chunk.fps,
                frame_data: vec![DeviceFrame {
                    frame_id: frame.frame_id,
                    device_id: device_data.device_name.clone(),
                    image_data: frame_data.clone(),
                    metadata: FrameMetadata {
                        file_path: device_data.video_file_path.clone(),
                        app_name: device_data.app_name.clone(),
                        window_name: device_data.window_name.clone(),
                        transcription: chunk
                            .audio_entries
                            .iter()
                            .map(|a| a.transcription.clone())
                            .collect::<Vec<_>>()
                            .join(" "),
                        ocr_text: device_data.text.clone(),
                        browser_url: device_data.browser_url.clone(),
                    },
                    audio_entries: chunk
                        .audio_entries
                        .iter()
                        .map(|a| AudioEntry {
                            transcription: a.transcription.clone(),
                            device_name: a.device_name.clone(),
                            is_input: a.is_input,
                            audio_file_path: a.audio_file_path.clone(),
                            duration_secs: a.duration_secs,
                            audio_chunk_id: a.audio_chunk_id,
                            speaker_id: a.speaker_id,
                            speaker_name: a.speaker_name.clone(),
                            start_time: a.start_time,
                            end_time: a.end_time,
                        })
                        .collect(),
                    machine_id: chunk.machine_id.clone(),
                }],
            })
            .await?;

        processed += 1;
    }

    debug!("processed {} frames from video file", processed);
    Ok(processed)
}

async fn is_video_file_complete(ffmpeg_path: &PathBuf, file_path: &str) -> Result<bool> {
    if let Ok(metadata) = tokio::fs::metadata(file_path).await {
        if let Ok(modified) = metadata.modified() {
            let age = SystemTime::now()
                .duration_since(modified)
                .unwrap_or_default();
            if age.as_secs() < 60 {
                return Ok(false);
            }
        }
    }

    let mut cmd = Command::new(ffmpeg_path);
    cmd.args(["-v", "error", "-i", file_path, "-f", "null", "-"]);

    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    match cmd.output().await {
        Ok(output) => {
            let is_complete = output.status.success();
            if !is_complete {
                debug!(
                    "file {} is incomplete or corrupted: {:?}",
                    file_path,
                    String::from_utf8_lossy(&output.stderr)
                );
            }
            Ok(is_complete)
        }
        Err(e) => {
            debug!("failed to check file {}: {}", file_path, e);
            Ok(false)
        }
    }
}

fn parse_timestamp(timestamp_str: &str) -> Result<DateTime<Utc>> {
    // First try direct RFC3339 parsing
    if let Ok(dt) = DateTime::parse_from_rfc3339(timestamp_str) {
        return Ok(dt.with_timezone(&Utc));
    }

    // Handle " UTC" suffix by converting to Z format
    let cleaned = timestamp_str.trim_end_matches(" UTC").replace(' ', "T");

    // Ensure we have a Z or +00:00 timezone marker
    let timestamp_with_tz = if !cleaned.ends_with('Z') && !cleaned.contains('+') {
        format!("{}Z", cleaned)
    } else {
        cleaned
    };

    DateTime::parse_from_rfc3339(&timestamp_with_tz)
        .map(|dt| dt.with_timezone(&Utc))
        .map_err(|e| anyhow::anyhow!("failed to parse timestamp '{}': {}", timestamp_str, e))
}

struct OrderedFrameStreamer {
    buffer: BTreeMap<DateTime<Utc>, Vec<TimeSeriesFrame>>,
    bucket_size: Duration,
    current_bucket: Option<DateTime<Utc>>,
    tx: mpsc::Sender<TimeSeriesFrame>,
    descending: bool,
}

impl OrderedFrameStreamer {
    fn new(tx: mpsc::Sender<TimeSeriesFrame>, bucket_size: Duration, descending: bool) -> Self {
        Self {
            buffer: BTreeMap::new(),
            bucket_size,
            current_bucket: None,
            tx,
            descending,
        }
    }

    async fn push(&mut self, frame: TimeSeriesFrame) -> Result<()> {
        let ts = frame.timestamp;

        // Initialize current_bucket if not set
        if self.current_bucket.is_none() {
            self.current_bucket = Some(ts);
            debug!("initialized first bucket at: {}", ts);
        }

        self.buffer.entry(ts).or_default().push(frame);

        // Sort frames within timestamp for consistency
        if let Some(frames) = self.buffer.get_mut(&ts) {
            frames.sort_by(|a, b| {
                a.frame_data
                    .first()
                    .map(|f| &f.device_id)
                    .cmp(&b.frame_data.first().map(|f| &f.device_id))
            });
        }

        // Flush completed buckets
        self.flush_completed_buckets().await
    }

    async fn flush_completed_buckets(&mut self) -> Result<()> {
        let Some(current_bucket) = self.current_bucket else {
            return Ok(());
        };

        // Determine bucket range - FIXED: Reversed logic for descending order
        let bucket_range = if self.descending {
            current_bucket..=(current_bucket + self.bucket_size)
        } else {
            (current_bucket - self.bucket_size)..=current_bucket
        };

        // Find frames ready to be sent (outside current bucket)
        let mut ready_timestamps: Vec<DateTime<Utc>> = self
            .buffer
            .keys()
            .filter(|ts| !bucket_range.contains(ts))
            .copied()
            .collect();

        if !ready_timestamps.is_empty() {
            // Sort timestamps based on direction
            ready_timestamps.sort_by(|a, b| {
                if self.descending {
                    // FIXED: Ensure we process older timestamps first in descending mode
                    a.cmp(b)
                } else {
                    b.cmp(a)
                }
            });

            // Send frames and update buffer
            for ts in ready_timestamps {
                if let Some(frames) = self.buffer.remove(&ts) {
                    for frame in frames {
                        self.tx.send(frame).await?;
                    }
                }
            }

            // Update current bucket
            self.current_bucket = self.buffer.keys().next().copied();
            debug!(
                "flushed bucket, new current bucket: {:?}",
                self.current_bucket
            );
        }

        Ok(())
    }

    async fn finish(self) -> Result<()> {
        // Flush any remaining frames in buffer
        let mut remaining: Vec<TimeSeriesFrame> = self.buffer.into_values().flatten().collect();

        // Sort remaining frames
        if self.descending {
            remaining.sort_by_key(|frame| std::cmp::Reverse(frame.timestamp));
        } else {
            remaining.sort_by_key(|frame| frame.timestamp);
        }

        // Send remaining frames
        for frame in remaining {
            self.tx.send(frame).await?;
        }

        debug!("streamer finished, sent all remaining frames");
        Ok(())
    }
}

async fn get_video_fps(ffmpeg_path: &PathBuf, video_path: &str) -> Result<f64> {
    let mut cmd = Command::new(ffmpeg_path);
    cmd.args(["-i", video_path]);

    #[cfg(windows)]
    {
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        cmd.creation_flags(CREATE_NO_WINDOW);
    }

    let output = cmd.output().await?;

    // ffmpeg outputs metadata to stderr by design
    let metadata = String::from_utf8_lossy(&output.stderr);

    // Look for fps info in patterns like: "23.98 fps" or "30 fps" or "29.97 fps"
    let fps = metadata
        .lines()
        .find(|line| line.contains("fps") && !line.contains("Stream"))
        .and_then(|line| {
            line.split_whitespace()
                .find(|&word| word.parse::<f64>().is_ok())
                .and_then(|n| n.parse::<f64>().ok())
        })
        .unwrap_or(1.0);

    debug!("detected fps from video metadata: {}", fps);
    Ok(fps)
}

fn is_older_than_24h(timestamp: &DateTime<Utc>) -> bool {
    Utc::now() - *timestamp > Duration::hours(24)
}
