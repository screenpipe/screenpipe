<!-- screenpipe — AI that knows everything you've seen, said, or heard -->
<!-- https://screenpipe.com -->
# Text-to-speech

`POST /v1/tts` accepts `{"text":"Text to speak"}` and returns `audio/mpeg`. It uses Screenpipe account authentication and requires Business. Any authorized client can use it; workflow guides are one caller. Guide editing, screenshots, captions, and video rendering stay in the local harness tool.

## Configuration

- Store the company ElevenLabs key as alias `default` in the existing authenticated Cloudflare AI Gateway. Never put provider credentials in clients or this repository.
- Configure `ELEVENLABS_VOICE_ID` with a licensed stock voice and `ELEVENLABS_USD_PER_CHARACTER` with the contracted character price, including applicable overhead.
- Enable `TTS_ENABLED=true` after deployment and verification. Missing or invalid configuration fails closed. Set it to false to stop new speech requests.
- The server controls the model (`eleven_multilingual_v2`) and MP3 format. No new end-user provider connection is required.

## Limits and accounting

Requests accept 1–800 characters with a bounded input body and a 60-second provider timeout. Text that exceeds the conservative unpriced-model cost reservation must be split into smaller requests. Existing atomic D1 admission and settlement enforce usage limits; successful calls settle the configured character cost, while ambiguous failures retain conservative accounting. No token counts are fabricated. Speech charges are not yet included in Cloudflare's token-based chat usage display.

## Verification

Local Worker/D1 tests cover account entitlement, input bounds, BYOK headers, payload-log suppression, provider failures, and cost settlement. Before promotion, generate synthetic speech using a Business account, decode the returned MP3, and verify the applied usage settlement and cleared reservation. Each caller separately validates its own playback or export flow.

Cloudflare documentation: [ElevenLabs](https://developers.cloudflare.com/ai-gateway/usage/providers/elevenlabs/) and [BYOK](https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/).
