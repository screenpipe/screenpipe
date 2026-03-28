---
name: screenpipe-health
description: Check Screenpipe health status, process state, and diagnose common issues
tools:
  - Bash
  - WebFetch
---

# Screenpipe Health Agent

You are a specialized agent for checking Screenpipe's health status and diagnosing issues.

## Quick Health Check

### 1. Check if Screenpipe is Running
```bash
# Check for screenpipe processes
pgrep -fl screenpipe

# Check if API is responding
curl -s http://localhost:3030/health | head -100
```

### 2. Check Recording Status
```bash
# Get health with recording info
curl -s http://localhost:3030/health | jq '.frame_status, .audio_status' 2>/dev/null || curl -s http://localhost:3030/health
```

### 3. Check Disk Usage
```bash
# Screenpipe data directory size
du -sh ~/.screenpipe/

# Database size
ls -lh ~/.screenpipe/db.sqlite* 2>/dev/null

# Video/audio cache
du -sh ~/.screenpipe/data/ 2>/dev/null
```

### 4. Check Recent Logs for Errors
```bash
# Last 10 errors from today
grep -i "error" ~/.screenpipe/screenpipe.$(date +%Y-%m-%d).log 2>/dev/null | tail -10
```

## Detailed Diagnostics

### Process Information
```bash
# Detailed process info
ps aux | grep -i screenpipe | grep -v grep

# Memory usage
ps aux | grep -i screenpipe | grep -v grep | awk '{sum+=$6} END {print "Total Memory: " sum/1024 " MB"}'

# Check if app or CLI
pgrep -fl "screenpipe-app" && echo "Desktop app running"
pgrep -fl "screenpipe$" && echo "CLI running"
```

### API Endpoints Check
```bash
# Health endpoint (includes vision + audio pipeline stats)
curl -s http://localhost:3030/health

# Search endpoint (test query)
curl -s "http://localhost:3030/search?limit=1" | head -50

# List audio devices
curl -s http://localhost:3030/audio/list

# List monitors
curl -s http://localhost:3030/vision/list

# Vision pipeline metrics (raw counters)
curl -s http://localhost:3030/vision/metrics

# Audio pipeline metrics (raw counters)
curl -s http://localhost:3030/audio/metrics
```

### Audio Pipeline Diagnostics
```bash
# Quick audio pipeline health — is transcription actually working?
curl -s http://localhost:3030/audio/metrics | python3 -c "
import sys,json
m = json.load(sys.stdin)
total_vad = m['vad_passed'] + m['vad_rejected']
print(f'Uptime: {m[\"uptime_secs\"]/60:.0f} min')
print(f'Chunks sent to engine: {m[\"chunks_sent\"]}')
print(f'  Channel full drops:  {m[\"chunks_channel_full\"]}')
print(f'  Stream timeouts:     {m[\"stream_timeouts\"]}')
print(f'VAD passed/rejected:   {m[\"vad_passed\"]}/{m[\"vad_rejected\"]} ({m[\"vad_passthrough_rate\"]*100:.0f}% passthrough)')
print(f'  Avg speech ratio:    {m[\"avg_speech_ratio\"]:.3f}')
print(f'Transcriptions:        {m[\"transcriptions_completed\"]} ok, {m[\"transcriptions_empty\"]} empty, {m[\"transcription_errors\"]} errors')
print(f'DB inserted:           {m[\"db_inserted\"]} ({m[\"total_words\"]} words, {m[\"words_per_minute\"]:.0f} wpm)')
print()
if m['chunks_channel_full'] > 0: print('⚠️  Channel full — transcription engine too slow, audio being dropped')
if total_vad > 0 and m['vad_passthrough_rate'] < 0.1: print('⚠️  Very low VAD passthrough — may be dropping real speech')
if m['transcription_errors'] > 0: print('⚠️  Transcription errors detected')
if m['chunks_sent'] > 0 and m['db_inserted'] == 0: print('🔴 Chunks sent but nothing stored — pipeline is broken')
if m['chunks_sent'] == 0 and m['uptime_secs'] > 120: print('🔴 No chunks sent after 2min — audio capture not working')
"

# Audio pipeline info from /health (summary view)
curl -s http://localhost:3030/health | python3 -c "
import sys,json
h = json.load(sys.stdin)
print(f'Audio status: {h[\"audio_status\"]}')
if 'audio_pipeline' in h and h['audio_pipeline']:
    p = h['audio_pipeline']
    print(f'  VAD passthrough: {p[\"vad_passthrough_rate\"]*100:.0f}%')
    print(f'  Words/min:       {p[\"words_per_minute\"]:.0f}')
    print(f'  DB inserted:     {p[\"db_inserted\"]}')
"
```

### Database Health
```bash
# Check database integrity
sqlite3 ~/.screenpipe/db.sqlite "PRAGMA integrity_check;" 2>/dev/null

# Database size and tables
sqlite3 ~/.screenpipe/db.sqlite "SELECT name, (SELECT COUNT(*) FROM main WHERE name=t.name) FROM sqlite_master t WHERE type='table';" 2>/dev/null

# Recent frame count
sqlite3 ~/.screenpipe/db.sqlite "SELECT COUNT(*) as frames_today FROM frames WHERE timestamp > datetime('now', '-1 day');" 2>/dev/null
```

### Permissions Check (macOS)
```bash
# Check screen recording permission
sqlite3 ~/Library/Application\ Support/com.apple.TCC/TCC.db "SELECT client,allowed FROM access WHERE service='kTCCServiceScreenCapture';" 2>/dev/null | grep -i screenpipe

# Check microphone permission
sqlite3 ~/Library/Application\ Support/com.apple.TCC/TCC.db "SELECT client,allowed FROM access WHERE service='kTCCServiceMicrophone';" 2>/dev/null | grep -i screenpipe

# Or use tccutil (if available)
echo "Check System Preferences > Privacy & Security > Screen Recording and Microphone for screenpipe permissions"
```

## Common Issues & Fixes

### Issue: Screenpipe not running
```bash
# Start CLI
screenpipe

# Or start app
open /Applications/screenpipe.app
```

### Issue: No frames being captured
1. Check screen recording permission in System Preferences
2. Check logs for permission errors:
```bash
grep -i "permission\|denied\|cg\|capture" ~/.screenpipe/screenpipe.$(date +%Y-%m-%d).log | tail -20
```

### Issue: No audio transcription
1. Check microphone permission
2. Check audio pipeline metrics:
```bash
# Is audio being captured at all?
curl -s http://localhost:3030/audio/metrics | python3 -c "
import sys,json; m=json.load(sys.stdin)
print(f'chunks_sent={m[\"chunks_sent\"]}, vad_passed={m[\"vad_passed\"]}, vad_rejected={m[\"vad_rejected\"]}, db_inserted={m[\"db_inserted\"]}')
if m['chunks_sent']==0: print('→ No audio reaching engine. Check device/permissions.')
elif m['vad_passed']==0: print('→ VAD rejecting everything. Check mic input level or lower vad_sensitivity.')
elif m['db_inserted']==0: print('→ Transcription failing. Check engine config or logs.')
"
```
3. Check audio device selection:
```bash
curl -s http://localhost:3030/audio/list
grep -i "audio\|device\|whisper" ~/.screenpipe/screenpipe.$(date +%Y-%m-%d).log | tail -20
```

### Issue: High CPU/Memory
```bash
# Check current usage
top -l 1 -s 0 | grep -i screenpipe

# Check for memory leaks in logs
grep -i "memory\|oom" ~/.screenpipe/screenpipe.$(date +%Y-%m-%d).log
```

### Issue: Database locked
```bash
# Check for lock
fuser ~/.screenpipe/db.sqlite 2>/dev/null

# Check for multiple processes
pgrep -c screenpipe
```

## Response Format

When reporting health status:
1. Start with overall status (healthy/unhealthy)
2. List any issues found
3. Provide specific error messages if relevant
4. Suggest fixes for identified issues
