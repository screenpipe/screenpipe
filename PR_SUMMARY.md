# Pull Request: Add OpenAI Compatible Transcription Engine Support

## Branch: `oAICompat`

## Summary

This PR adds support for OpenAI-compatible transcription APIs to Screenpipe's recording settings. Users can now configure any server that implements the OpenAI Audio Transcriptions API format (e.g., llama.cpp, ollama, vLLM, LocalAI) as their transcription engine.

## Changes

### Backend (Rust)

#### New Files
- `crates/screenpipe-audio/src/transcription/openai_compatible/mod.rs` - Module definition with default endpoint constant
- `crates/screenpipe-audio/src/transcription/openai_compatible/batch.rs` - Transcription client implementation

#### Modified Files
- `crates/screenpipe-audio/src/core/engine.rs` - Added `OpenAICompatible` variant to `AudioTranscriptionEngine` enum
- `crates/screenpipe-audio/src/transcription/mod.rs` - Exported new `openai_compatible` module
- `crates/screenpipe-audio/src/transcription/stt.rs` - Added `OpenAICompatibleConfig` struct and integrated OpenAI Compatible into STT flow
- `crates/screenpipe-audio/src/audio_manager/builder.rs` - Added OpenAI Compatible config to `AudioManagerOptions` and builder
- `crates/screenpipe-audio/src/audio_manager/manager.rs` - Pass OpenAI Compatible config to `process_audio_input`
- `crates/screenpipe-server/src/cli.rs` - Added `OpenAICompatible` variant to CLI enum
- `apps/screenpipe-app-tauri/src-tauri/src/embedded_server.rs` - Added OpenAI Compatible settings to `EmbeddedServerConfig` and audio manager builder

### Frontend (React/TypeScript)

#### Modified Files
- `apps/screenpipe-app-tauri/components/settings/recording-settings.tsx` - Added:
  - "OpenAI Compatible" option to transcription engine dropdown
  - API endpoint input field (default: `http://127.0.0.1:8080`)
  - API key input field (optional, with show/hide toggle)
  - Model selection dropdown populated from `/v1/models` endpoint
  - Error handling with `!API_Error` fallback when model fetch fails

## Features

### UI Configuration
When "OpenAI Compatible" is selected as the transcription engine, users see:
1. **API Endpoint** - Text input with default `http://127.0.0.1:8080`
2. **API Key** - Optional password field with visibility toggle
3. **Model Selection** - Dropdown populated from the server's `/v1/models` endpoint

### API Compatibility
The implementation follows the OpenAI Audio Transcriptions API format:
- **Endpoint**: `POST /v1/audio/transcriptions`
- **Request**: Multipart form with `file` (audio WAV), `model`, and optional `language`
- **Response**: JSON with `text` field containing transcription

### Error Handling
- If `/v1/models` fetch fails, dropdown shows `!API_Error`
- Transcription failures fall back to local Whisper
- Connection errors are logged with descriptive messages

## Testing

- [x] Rust code compiles without errors (`cargo check`)
- [x] Frontend TypeScript changes are syntactically correct
- [ ] Manual testing with llama.cpp server
- [ ] Manual testing with ollama
- [ ] Manual testing with vLLM

## Usage

1. Navigate to Settings → Recording → Audio
2. Select "OpenAI Compatible" from the Transcription engine dropdown
3. Enter your API endpoint (e.g., `http://127.0.0.1:8080`)
4. Optionally enter an API key
5. Select a model from the dropdown (auto-populated from server)
6. Click "Apply & Restart"

## Compatible Servers

This feature works with any server implementing the OpenAI Audio Transcriptions API:
- [llama.cpp](https://github.com/ggerganov/llama.cpp) (with `--endpoint` option)
- [ollama](https://github.com/ollama/ollama) (with OpenAI compatibility)
- [vLLM](https://github.com/vllm-project/vllm)
- [LocalAI](https://github.com/mudler/LocalAI)
- Any custom server implementing the OpenAI API format

## Screenshots

_N/A - UI follows existing Deepgram configuration pattern_

## Breaking Changes

None. This is a purely additive feature.

## Migration Notes

No migration needed. Settings are stored in the existing `extra` field of `SettingsStore`:
- `openaiCompatibleEndpoint`
- `openaiCompatibleApiKey`
- `openaiCompatibleModel`
