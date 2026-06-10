-- Speed up the background snapshot-compaction scan.
-- snapshot_compaction.rs runs this query every compaction cycle:
--   SELECT id, snapshot_path, device_name, timestamp FROM frames
--   WHERE snapshot_path IS NOT NULL AND timestamp < ?1
--   ORDER BY device_name, timestamp ASC LIMIT 5000
--
-- None of the existing indexes match it: idx_frames_snapshot_path is ordered by
-- snapshot_path (so the device_name,timestamp ORDER BY needs a temp B-tree sort),
-- and idx_frames_timestamp_device leads with timestamp (wrong order for the
-- ORDER BY). With weeks of data this degrades into a multi-second full table
-- scan + sort that runs on a timer and contends with the HTTP/API runtime,
-- contributing to the high-CPU / unresponsive-server behavior in #183.
--
-- This partial index matches the query exactly: it indexes only not-yet-compacted
-- frames (snapshot_path IS NOT NULL) in (device_name, timestamp) order, so SQLite
-- satisfies both the WHERE filter and the ORDER BY directly from the index with no
-- sort, scanning only the small uncompacted subset instead of the whole table.
CREATE INDEX IF NOT EXISTS idx_frames_snapshot_compaction
  ON frames(device_name, timestamp)
  WHERE snapshot_path IS NOT NULL;
