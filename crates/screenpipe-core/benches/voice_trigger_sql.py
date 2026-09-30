#!/usr/bin/env python3
# screenpipe — AI that knows everything you've seen, said, or heard
# https://screenpipe.com
"""Disposable WAL probe using the production SELECTs and 1M synthetic rows.
Run: python3 crates/screenpipe-core/benches/voice_trigger_sql.py
Minimal schema, standard-library SQLite. Does not measure HTTP, SQLx, capture,
FTS indexing or hybrid-storage coordination. Never accesses a live user DB.
"""
import json
from pathlib import Path
import re
import sqlite3
import tempfile
import threading
import time

source = (Path(__file__).resolve().parents[1] / "src/pipes/connection_triggers/voice.rs").read_text()
cap = int(re.search(r"MAX_TRANSCRIPT_CHARS: usize = ([\d_]+)", source)[1].replace("_", ""))
query = re.search(r'format!\("(SELECT id, timestamp, substr[^"\n]+)"\)', source)[1]
query = query.replace("{MAX_TRANSCRIPT_CHARS}", str(cap)).replace("{read_chars}", str(cap + 1)).replace("{after}", "?")
baseline = re.search(r'"(SELECT COALESCE\(MAX\(id\), 0\)[^"\n]+)"', source)[1]
rows, iterations = 1_000_000, 2000


def summary(values):
    ordered = sorted(values)
    return {"samples": len(values), "p50_ms": round(ordered[len(ordered)//2], 3),
            "p95_ms": round(ordered[int(len(ordered)*.95)], 3), "max_ms": round(max(values), 3)}


with tempfile.TemporaryDirectory(prefix="voice-sql-probe-") as temp:
    path = str(Path(temp) / "probe.db")
    setup = sqlite3.connect(path)
    setup.execute("PRAGMA journal_mode=WAL")
    setup.execute("CREATE TABLE audio_transcriptions (id INTEGER PRIMARY KEY AUTOINCREMENT, timestamp TEXT, transcription TEXT, is_input_device INTEGER)")
    setup.executemany("INSERT INTO audio_transcriptions(timestamp, transcription, is_input_device) VALUES('2026-09-17', ?, ?)",
                      (("ordinary recorded words " * 5, i % 2) for i in range(rows)))
    setup.execute("UPDATE audio_transcriptions SET transcription=? WHERE id > ?", ("x" * (cap * 2), rows - 50))
    setup.commit()
    setup.close()
    reader = sqlite3.connect(path, timeout=.1)
    reader.execute("PRAGMA query_only=ON")
    plan = [row[3] for row in reader.execute("EXPLAIN QUERY PLAN " + query, (rows - 50,))]
    assert any("INTEGER PRIMARY KEY" in row and "rowid>?" in row for row in plan), plan
    assert not any("TEMP B-TREE" in row for row in plan), plan
    baseline_plan = [row[3] for row in reader.execute("EXPLAIN QUERY PLAN " + baseline)]
    baseline_ms = []
    for _ in range(100):
        start = time.perf_counter()
        assert reader.execute(baseline).fetchone()[0] == rows
        baseline_ms.append((time.perf_counter() - start) * 1000)
    writer_alone_ms = []
    alone = sqlite3.connect(path, timeout=.1, isolation_level=None)
    for _ in range(iterations):
        start = time.perf_counter()
        alone.execute("INSERT INTO audio_transcriptions(timestamp, transcription, is_input_device) VALUES('2026-09-17', 'start job Acme', 1)")
        writer_alone_ms.append((time.perf_counter() - start) * 1000)
    alone.close()
    errors, writer_ms, scan_ms = [], [], []
    ready = threading.Event()

    def write():
        conn = sqlite3.connect(path, timeout=.1, isolation_level=None)
        ready.wait()
        try:
            for _ in range(iterations):
                start = time.perf_counter()
                conn.execute("INSERT INTO audio_transcriptions(timestamp, transcription, is_input_device) VALUES('2026-09-17', 'start job Acme', 1)")
                writer_ms.append((time.perf_counter() - start) * 1000)
        except sqlite3.Error as error:
            errors.append(str(error))
        finally:
            conn.close()

    worker = threading.Thread(target=write)
    worker.start()
    ready.set()
    try:
        for _ in range(iterations):
            start = time.perf_counter()
            batch = reader.execute(query, (rows - 50,)).fetchall()
            scan_ms.append((time.perf_counter() - start) * 1000)
            assert len(batch) == 50 and all(len(row[2]) == cap + 1 for row in batch)
    except sqlite3.Error as error:
        errors.append(str(error))
    worker.join(timeout=30)
    assert not worker.is_alive(), "writer exceeded 30 seconds"
    assert not errors, errors
    assert len(writer_ms) == iterations
    reader.close()
    print(json.dumps({"sqlite_version": sqlite3.sqlite_version, "rows": rows,
        "oversized_rows": 50, "returned_char_cap": cap + 1, "query_plan": plan,
        "baseline_plan": baseline_plan, "baseline": summary(baseline_ms),
        "writes_alone": summary(writer_alone_ms), "scan_during_writes": summary(scan_ms), "writes_during_scans": summary(writer_ms),
        "sqlite_errors": errors}, indent=2))
