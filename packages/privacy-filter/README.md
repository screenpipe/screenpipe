# privacy-filter

CPU-only HTTP wrapper around screenpipe's local PII redactors:

- **Text** — [`screenpipe/pii-redactor`](https://huggingface.co/screenpipe/pii-redactor) v45_phase3 (xlm-roberta-base fine-tune, INT8 ONNX, 278 MB, ~9 ms p50 on CPU). Same model the desktop app downloads on first run.
- **Image** — [`screenpipe/pii-image-redactor`](https://huggingface.co/screenpipe/pii-image-redactor) rfdetr_v9 (RF-DETR-Nano, 108 MB FP32 ONNX, ~140 ms p50 on CPU, 12 PII classes, 95%+ zero-leak on the screenleak image bench).

Deployed inside a [Tinfoil](https://tinfoil.sh) confidential-compute enclave so the bytes never leave an attested runtime. Sits in front of screenpipe's outbound LLM calls so screen telemetry / screenshots are redacted before they reach any third-party model.

## API

```
GET  /health
  → {"status":"ok", "text_ready":true, "image_ready":true,
     "text_model":"screenpipe/pii-redactor:v45_phase3",
     "image_model":"screenpipe/pii-image-redactor:rfdetr_v9"}

POST /filter
  ← {"text": "My email is alice@foo.com"}
  → {"redacted":"My email is [EMAIL]",
     "spans":[{"label":"private_email","start":12,"end":25,
               "text":"alice@foo.com","score":0.99}],
     "latency_ms":9, "model":"screenpipe/pii-redactor:v45_phase3"}

POST /image/detect
  ← {"image_b64":"<base64 JPG/PNG>", "threshold":0.30}
  → {"detections":[{"bbox":[x,y,w,h],"label":"private_person","score":0.95}, …],
     "latency_ms":142, "model":"screenpipe/pii-image-redactor:rfdetr_v9"}
```

Limits: `MAX_INPUT_CHARS=100000` (text) and `MAX_IMAGE_BYTES=8MB` (image) — both overridable via env.

## Local development

```bash
# build (models download from HF at build time, ~400 MB total)
docker build -t privacy-filter:dev .

# run
docker run --rm -p 8080:8080 privacy-filter:dev

# smoke
curl -s http://localhost:8080/health | jq
curl -s -X POST http://localhost:8080/filter \
     -H 'Content-Type: application/json' \
     -d '{"text":"Call Alice at +1 415 555 0100 about alice@example.com"}' | jq
```

First build pre-downloads both ONNX models into the image (~400 MB total — much smaller than the prior 1.5B-param container). Subsequent builds hit Docker's layer cache.

## Deploy to Tinfoil

1. Tag and push:

```bash
git tag privacy-filter-v0.2.0
git push origin privacy-filter-v0.2.0
```

The release workflow builds + pushes the image to `ghcr.io/screenpipe/privacy-filter:0.2.0` and prints the digest.

2. Paste the digest into `tinfoil-config.yml`'s `image:` line (the `@sha256:REPLACE_AFTER_BUILD` placeholder).

3. Commit + push that change. Tinfoil's dashboard auto-pulls on the next attestation check and exposes the service at `https://<name>.<org>.containers.tinfoil.dev`.

## What's in this container vs the desktop app

The desktop app downloads the same v45_phase3 ONNX (and the same rfdetr_v9) on first run and serves them locally — no network call per redaction. This container exists for clients that *can't* run the model locally:

- Browser extensions
- Low-end machines
- Server-side aggregations (analytics dashboards, etc.)

Tinfoil's confidential-compute attestation guarantees the enclave operator can't see the bytes either; the model digest is verifiable by the client before any data is sent.

## Versioning

| Container tag | Text model | Image model | Status |
|---|---|---|---|
| `0.2.0` | v45_phase3 (xlm-roberta-base) | rfdetr_v9 | **current** |
| `0.1.0` | openai/privacy-filter (1.5B MoE) | — | deprecated |

Bump the container tag whenever either model artifact changes. The desktop app and this container are kept in lockstep on the text model so outputs match across surfaces.
