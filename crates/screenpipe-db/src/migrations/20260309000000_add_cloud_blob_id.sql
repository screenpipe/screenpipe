-- Add cloud_blob_id to video_chunks and frames for tracking which media files
-- have been uploaded to cloud archive. Files are only deleted locally after
-- cloud_blob_id is set (upload confirmed).

ALTER TABLE video_chunks ADD COLUMN cloud_blob_id TEXT DEFAULT NULL;
ALTER TABLE frames ADD COLUMN cloud_blob_id TEXT DEFAULT NULL;

-- Index for efficient "what still needs uploading" queries
CREATE INDEX IF NOT EXISTS idx_video_chunks_cloud_blob_id
    ON video_chunks(cloud_blob_id) WHERE cloud_blob_id IS NULL;

CREATE INDEX IF NOT EXISTS idx_frames_cloud_blob_id
    ON frames(cloud_blob_id) WHERE cloud_blob_id IS NULL AND snapshot_path IS NOT NULL;
