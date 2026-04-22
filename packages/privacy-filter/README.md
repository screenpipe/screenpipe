# privacy-filter

CPU-only HTTP wrapper around [`openai/privacy-filter`](https://huggingface.co/openai/privacy-filter) — a 1.5B-param MoE (50M active) token classifier for PII detection.

Deployed inside a [Tinfoil](https://tinfoil.sh) confidential-compute enclave so the text never leaves an attested runtime. Intended to sit in front of screenpipe's outbound LLM calls so user data is masked before it reaches third-party models.

## API

```
GET  /health       → {"status": "ok", "model_ready": true, "model": "openai/privacy-filter"}
POST /filter       → {"text": "My email is alice@foo.com"}
                  ←  {"redacted": "My email is [EMAIL]",
                      "spans": [{"label": "private_email", "start": 12, "end": 25,
                                 "text": "alice@foo.com", "score": 0.99}],
                      "latency_ms": 180,
                      "model": "openai/privacy-filter"}
```

## Local development

```bash
# build
docker build -t privacy-filter:dev .

# run
docker run --rm -p 8080:8080 privacy-filter:dev

# smoke test
curl -s http://localhost:8080/health
curl -s -X POST http://localhost:8080/filter \
     -H 'Content-Type: application/json' \
     -d '{"text":"Call Alice at +1 415 555 0100 about alice@example.com"}' | jq
```

First build pre-downloads the 1.5B model (~3 GB bf16) into the image, so expect a 5–10 min initial build. Subsequent builds hit Docker's layer cache.

## Deploy to Tinfoil

1. **Push the image to a public registry** (GitHub Container Registry):

   ```bash
   VERSION=v0.1.0
   docker build -t ghcr.io/screenpipe/privacy-filter:$VERSION .
   docker push ghcr.io/screenpipe/privacy-filter:$VERSION

   # Grab the digest for tinfoil-config.yml (Tinfoil requires pinned digests).
   docker inspect --format='{{index .RepoDigests 0}}' \
     ghcr.io/screenpipe/privacy-filter:$VERSION
   ```

2. **Pin the digest** in `tinfoil-config.yml` — replace the `REPLACE_WITH_DIGEST`
   sentinel with the full `sha256:...` from the previous step. Commit and tag:

   ```bash
   git add tinfoil-config.yml
   git commit -m "release: privacy-filter $VERSION"
   git tag $VERSION && git push origin main --tags
   ```

3. **Click-through in the Tinfoil dashboard** (https://dash.tinfoil.sh):
   - create an org (if you haven't already)
   - connect the GitHub app to this repo
   - pick the tag to deploy
   - wait for status = `Running` (cold start ~30–60 s for the first model load)

4. **Verify** — the service is now reachable at
   `https://privacy-filter.<org>.containers.tinfoil.dev/health`.

## Resource sizing (why no GPU)

| Metric | Value |
|---|---|
| Weights (bf16) | ~3 GB |
| Active params per token | 50 M (MoE top-4 of 128 experts) |
| Attention window | 257 tokens (banded, O(N)) |
| RAM working set | ~4 GB |
| CPU latency (512 tokens) | ~400–800 ms |
| CPU throughput (8 vCPU) | ~10–20 req/sec short-text |

Bump `gpus: 1` + `runtime: nvidia` in `tinfoil-config.yml` only if production p95 latency exceeds your SLO.

## Security properties

- **Tinfoil remote attestation** covers the exact image digest, so clients can verify the specific model bits + server code that handled their request.
- **Only `/health` and `/filter` are exposed** — Tinfoil's `shim.paths` allowlist blocks every other URL at the enclave boundary, so no introspection / debug endpoints can leak.
- **Model weights are baked in** and `TRANSFORMERS_OFFLINE=1` — no runtime HuggingFace calls, so an attacker who subverts DNS can't swap weights out from under the enclave.
- **Runs as UID 10001 non-root** inside the container.

## Limitations

- English-primary. Multilingual coverage per upstream model card varies.
- Not a compliance certification. One layer in a privacy-by-design stack.
- 128K context upstream; we cap at `MAX_INPUT_TOKENS=8192` (override via env) to keep enclave memory bounded.
