-- Router + latency instrumentation so we can measure cost/performance/latency impact.
-- ALTER ... ADD COLUMN is metadata-only in SQLite/D1 (no table rewrite), so it is
-- safe on the ~17M-row cost_log — unlike CREATE INDEX, which OOMs (SQLITE_NOMEM) at
-- this size. All columns nullable; old rows read NULL.
--
-- latency_ms : time from request receipt to response object (≈ TTFB for streaming,
--              total for non-streaming — segment by the existing `stream` column).
-- router_tier: difficulty-router decision — 'trivial'|'normal'|'hard' (A/B arm ON),
--              'control' (arm OFF baseline), or NULL (router N/A or disabled).
ALTER TABLE cost_log ADD COLUMN latency_ms INTEGER;
ALTER TABLE cost_log ADD COLUMN router_tier TEXT;
