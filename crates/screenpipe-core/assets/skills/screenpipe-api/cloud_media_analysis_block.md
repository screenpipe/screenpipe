<!-- BEGIN_CLOUD_MEDIA_ANALYSIS -->

## Cloud audio + video + image analysis — `POST /v1/chat/completions`

Use this when the user asks about a meeting's audio, a video file, or any screen capture and you need actual multimodal understanding (not just OCR or tool-based retrieval). Runs Gemma 4 E4B inside an attested confidential enclave (Tinfoil on AMD SEV-SNP H200) — encrypted in flight, encrypted at rest, no plaintext at the provider. You call the local screenpipe server; it signs the upstream request with the user's cloud credential, which you do not have direct access to.

```bash
curl -X POST http://localhost:3030/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "gemma4-e4b",
    "max_tokens": 400,
    "messages": [{
      "role": "user",
      "content": [
        {"type": "audio_url", "audio_url": {"url": "data:audio/wav;base64,..."}},
        {"type": "image_url", "image_url": {"url": "data:image/png;base64,..."}},
        {"type": "text",      "text": "what is happening here?"}
      ]
    }]
  }'
```

### When to use it
- "transcribe this meeting / clip / voice memo" → `audio_url`
- "what's in this screen recording" → ffmpeg-sample keyframes → `image_url[]`
- "what did <speaker> say at <timestamp>" → grab `audio_chunk_id` via §6, send the file as `audio_url`
- "analyze this video" → up to 4 keyframes per request via `image_url[]`

### Limits & format
- 1 audio + up to 4 images per request (vLLM `--limit-mm-per-prompt`)
- Audio: 30 s max per clip (Gemma 4 spec); WAV/MP3 base64
- Context: 128K tokens (model); `max_model_len` is 8192 in this deployment
- Latency: ~5 s for 30 s audio, ~2 s for an image

### Failure modes
- `503 cloud_token_missing` — the user is signed out of screenpipe cloud. Tell them to sign in (Settings → Account) and retry.
- `502 upstream_unreachable` — transient network issue against the enclave. Retry once; if it persists, report the error and fall back to local tools.

### When NOT to use it
- For arbitrary text chat use the user's configured chat model (Claude, Gemini, etc.) — `gemma4-e4b` is for media.
- If the user has explicitly asked for local-only / on-device processing, skip this and use local tools (whisper.cpp, ffmpeg, etc.).

<!-- END_CLOUD_MEDIA_ANALYSIS -->
