# screenpipe memory leak hunt

This is a 24/7 pressure loop for the "screenpipe reached 20 GB after a week" class of bugs.

It does two things at once:

- samples the largest `screenpipe-app`, `screenpipe`, or `screenpipe-engine` process RSS/CPU/fd count every 30s
- rotates through pressure scenarios against the local API: health polling, search fanout, timeline streaming, frame metadata/text/context reads, meetings, memories/artifacts, audio status, and websocket churn

It writes diagnostics only under:

```bash
~/.screenpipe/diagnostics/memory-leak
```

Start the loop:

```bash
python3 scripts/memory-leak/leak_hunt.py start
```

Check status:

```bash
python3 scripts/memory-leak/leak_hunt.py status --analyze
```

Stop it:

```bash
python3 scripts/memory-leak/leak_hunt.py stop
```

Run a shorter foreground check:

```bash
python3 scripts/memory-leak/leak_hunt.py run --duration-sec 900 --scenario-duration-sec 60 --concurrency 8
```

When RSS crosses 8 GB, or the one-hour slope crosses 512 MB/hour, the harness captures extra evidence when macOS tools are available:

- `vmmap -summary`
- `sample`
- `lsof`
- thread listing

Frame image reads and audio start/stop churn are off by default because they are heavier and can disturb normal recording. Enable them only during focused reproduction:

```bash
python3 scripts/memory-leak/leak_hunt.py start --include-frame-images
python3 scripts/memory-leak/leak_hunt.py start --allow-audio-toggle
```

Ignored DB pressure tests:

```bash
cargo test -p screenpipe-db --test memory_pressure_test -- --ignored --nocapture
```

Useful targeted variants:

```bash
# Read/search/timeline/meeting pressure only.
SCREENPIPE_PRESSURE_FRAMES=1000 \
SCREENPIPE_PRESSURE_AUDIO=200 \
SCREENPIPE_PRESSURE_UI=1000 \
SCREENPIPE_PRESSURE_MEETINGS=10 \
SCREENPIPE_PRESSURE_ROUNDS=8 \
cargo test -p screenpipe-db --test memory_pressure_test repeated_search_timeline_meeting_reads_do_not_grow_unbounded -- --ignored --nocapture

# Write-only churn with a small writer delay.
SCREENPIPE_PRESSURE_CHURN_SECONDS=10 \
SCREENPIPE_PRESSURE_READERS=0 \
SCREENPIPE_PRESSURE_WRITER_SLEEP_MS=1 \
cargo test -p screenpipe-db --test memory_pressure_test concurrent_write_read_churn_stays_bounded -- --ignored --nocapture

# Mixed write/read churn with the same writer delay.
SCREENPIPE_PRESSURE_CHURN_SECONDS=10 \
SCREENPIPE_PRESSURE_READERS=4 \
SCREENPIPE_PRESSURE_WRITER_SLEEP_MS=1 \
cargo test -p screenpipe-db --test memory_pressure_test concurrent_write_read_churn_stays_bounded -- --ignored --nocapture
```
