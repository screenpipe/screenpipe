-- Drop unused tables that have no inserts or queries in the codebase.

-- friend_wearable_requests: created for wearable API feature that was never completed.
-- No INSERT or SELECT statements exist anywhere in the codebase.
DROP TABLE IF EXISTS friend_wearable_requests;

-- ocr_text_embeddings: created for an embedding pipeline that was never implemented.
-- No INSERT statements exist anywhere in the codebase.
DROP TABLE IF EXISTS ocr_text_embeddings;

-- chunked_text_*: legacy text chunking system, only referenced in deletion cleanup.
-- No active inserts or reads.
DROP TABLE IF EXISTS chunked_text_index_fts;
DROP TABLE IF EXISTS chunked_text_entries;
DROP TABLE IF EXISTS chunked_text_index;
