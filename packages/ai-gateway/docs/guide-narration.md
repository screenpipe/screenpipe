<!-- screenpipe — AI that knows everything you've seen, said, or heard -->
<!-- https://screenpipe.com -->
# Guide narration rollout

The desktop's existing Pi harness calls `render_guide_video` with a reviewed local scene manifest. The tool sends narration text to Screenpipe's authenticated `/v1/guide-narration` route, then renders screenshots, captions and voice locally with bundled FFmpeg. No new end-user provider connection is required. This does not publish a guide, implement a web editor, or expose localhost to a website.

## Configure before enabling

1. In the existing authenticated Cloudflare AI Gateway, add the company's ElevenLabs provider key with alias `default`. Use the Provider Keys panel or the approved Secrets Store adapter. Never put the provider key in the desktop or this repository.
2. Select a licensed stock voice and configure Worker `ELEVENLABS_VOICE_ID`.
3. Set private Worker `ELEVENLABS_USD_PER_CHARACTER` to the contracted price for `eleven_multilingual_v2`, including applicable overhead. Missing/invalid pricing fails closed. The model and MP3 format are server-controlled.
4. Deploy the tested Worker, then enable `GUIDE_NARRATION_ENABLED=true` for the canary. Its default is disabled. Restore false to stop new narration without affecting saved guides.
5. With a Business test account, request a synthetic narration and verify its audio, the character-cost ledger entry, and cleared reservation. Verify Basic/Free rejection, cancellation, and provider failure. Do not log bearer tokens, script text or audio.
6. Run the installed desktop through edit, render, Stop, retry and MP4 export. Confirm that the bundled FFmpeg supports libx264, AAC and libass subtitles on every supported platform before release.

Cloudflare supports ElevenLabs via its provider-native endpoint. BYOK setup: https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/ . Provider endpoint: https://developers.cloudflare.com/ai-gateway/usage/providers/elevenlabs/ .

## Accounting and limits

Narration reuses the existing atomic D1 cost admission and settlement used by hosted voice requests. It reserves the conservative unpriced-model hold, rejects scripts that would exceed that hold, and settles the configured character cost on success. Ambiguous failures retain conservative accounting. Narration does not claim that Cloudflare's token-based chat usage display includes its character charges; surfacing speech usage alongside chat remains a follow-up.

Each video currently has at most 12 scenes and each narration at most 800 characters. Rendering is local; selected screenshots must already be visually verified and match the guide's workflow revision. Export requires a save destination. Captions are phrase-sized and timed proportionally to the measured narration duration, not forced-alignment word timestamps. Retrying a render currently regenerates narration; caching unchanged audio is a follow-up before a broad rollout.

## Current proof boundary

Local Worker/D1 tests use a network-closed synthetic provider. Renderer tests use generated tone audio, not ElevenLabs, and do not establish voice quality. Browser fixtures demonstrate layout, edits, progress and failures only. A live ElevenLabs canary and native render/export smoke are required before marking this integration release-ready.
