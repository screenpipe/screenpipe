# screenpipe — AI that knows everything you've seen, said, or heard
# https://screenpipe.com

"""Synthetic, warm-cache SQL comparison. No recorder or customer data is read.
Run manually: python3 scripts/benchmark-day-start.py
"""
import json
from pathlib import Path
import re
import sqlite3
import statistics
import time

root = Path(__file__).resolve().parents[1]
source = (root / "crates/screenpipe-db/src/day_start.rs").read_text()
current_sql = re.search(r'const FIRST_INPUT_SQL: &str = "(.*?)";', source, re.S).group(1)
baseline_sql = """
SELECT id AS event_id, timestamp, event_type, machine_id FROM ui_events
WHERE timestamp >= ?1 AND timestamp < ?2
  AND julianday(timestamp) >= julianday(?3) AND julianday(timestamp) < julianday(?4)
  AND ((?5 IS NULL AND machine_id IS NULL)
       OR machine_id IN (SELECT value FROM json_each(?5)))
  AND event_type IN ('click', 'move', 'scroll', 'key', 'text')
ORDER BY julianday(timestamp), id LIMIT 1
"""
connection = sqlite3.connect(":memory:")
connection.executescript("""
CREATE TABLE ui_events(id INTEGER PRIMARY KEY, timestamp TEXT, event_type TEXT, machine_id TEXT);
CREATE INDEX idx_ui_events_timestamp ON ui_events(timestamp);
CREATE INDEX idx_ui_events_event_type ON ui_events(event_type);
""")
connection.execute("""
WITH RECURSIVE seq(i) AS (VALUES(0) UNION ALL SELECT i+1 FROM seq WHERE i<999999)
INSERT INTO ui_events
SELECT i, strftime('%Y-%m-%dT%H:%M:%fZ', '2025-01-01', printf('+%d seconds',i*60)),
       CASE WHEN i%3=0 THEN 'app_switch' ELSE 'click' END,
       printf('device-%d',i%100)
FROM seq
""")
connection.commit()
parameters = (
    "2026-11-04T08:00:00+00:00", "2026-11-07T08:00:00+00:00",
    "2026-11-05T08:00:00+00:00", "2026-11-06T08:00:00+00:00", '["device-5"]',
)
report = {"rows": 1_000_000, "devices": 100, "sqlite": sqlite3.sqlite_version, "results": {}}
for label, sql in [("before", baseline_sql), ("after", current_sql)]:
    plan = [row[3] for row in connection.execute("EXPLAIN QUERY PLAN " + sql, parameters)]
    samples = []
    for _ in range(12):
        started = time.perf_counter()
        result = connection.execute(sql, parameters).fetchone()
        samples.append((time.perf_counter() - started) * 1000)
    warmed = samples[2:]
    report["results"][label] = {
        "p50_ms": statistics.median(warmed), "p95_ms": sorted(warmed)[-1],
        "result": result, "plan": plan,
    }
assert report["results"]["before"]["result"] == report["results"]["after"]["result"]
assert any("idx_ui_events_timestamp" in step for step in report["results"]["after"]["plan"])
print(json.dumps(report, indent=2))
