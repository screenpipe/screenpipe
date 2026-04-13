-- Partial index on frames.elements_ref_frame_id to eliminate the full
-- table scan in the retention anchor-frame subquery.
--
-- The correlated subquery in delete_time_range_batch:
--   SELECT DISTINCT f.id FROM frames f
--   WHERE f.timestamp BETWEEN ?1 AND ?2
--   AND EXISTS (SELECT 1 FROM frames ref
--               WHERE ref.elements_ref_frame_id = f.id
--               AND ref.timestamp NOT BETWEEN ?1 AND ?2)
--
-- falls back to a full scan of `frames` on the inner EXISTS without this
-- index (elements_ref_frame_id was added in 20260318000000 without one).
-- Measured 5m55s per 1-hour retention batch on a 33k-frame DB, making
-- retention unusable on any non-trivial backlog.
--
-- With the index, the inner plan becomes:
--   SEARCH ref USING INDEX idx_frames_elements_ref_frame_id (elements_ref_frame_id=?)
-- and the same query runs in ~5ms.
--
-- Partial (WHERE elements_ref_frame_id IS NOT NULL) because only frames
-- that reference a dedup anchor are relevant here. Storage cost is
-- negligible -- single-digit MB/year for typical capture volume, and it
-- is the smallest index on the frames table by a wide margin.
CREATE INDEX IF NOT EXISTS idx_frames_elements_ref_frame_id
    ON frames(elements_ref_frame_id)
    WHERE elements_ref_frame_id IS NOT NULL;
