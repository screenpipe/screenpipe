# screenpipe-sync

Generic data-sync primitives shared across the screenpipe codebase.

Pluggable byte-blob destinations, optional body encryption, and a ticketed-upload pipeline for the "ask control plane for a presigned URL, PUT the body, POST a completion manifest" flow that every direct-upload backend uses.

This crate has no knowledge of screenpipe's database, no knowledge of any specific ingest contract, and no background scheduler. Callers compose the pieces.

## What's in here

- `destination::BlobDestination` — trait. `(body, content_type, headers) -> outcome`.
  - `HttpPutDirect` — PUT to a fully-resolved URL. Covers presigned S3 / Azure SAS / GCS V4 / R2 / on-prem signed-URL services through one code path. No per-cloud SDK deps.
  - `LocalFsDestination` — write to a directory. For tests and BYO-storage-via-mount.
- `pipeline::TicketedPipeline` — orchestrates ticket → PUT → complete. The manifest JSON shapes are caller-supplied so ingest wire formats stay caller-owned.
- `encrypt::ChaCha20Poly1305Encryptor` — per-batch data key + per-recipient key wrap (primary + recovery). Optional, gated behind the `encrypt` feature (default on).
- `jsonl::encode` — newline-delimited JSON helper.
- `cursor::Cursor<T>` — atomic JSON-file cursor for "remember where we left off."
- `hash::sha256_hex` — content addressing helper.

## What's NOT in here

- No DB or schema knowledge. Callers wrap their own record types.
- No background `SyncRunner` yet — landing once the SDK integration is wired.
- No native cloud SDKs. Presigned URLs cover the common case; native SDK destinations can land later as additive trait impls.

## Why a separate crate

Today the same patterns are re-implemented in three places: consumer cloud sync (`screenpipe-core::sync`), the enterprise telemetry sync (`ee/desktop-rust/enterprise_sync.rs`), and the cloud-archive media path (`screenpipe-engine/archive.rs`). Extracting the generic plumbing lets each caller keep its own wire format and crypto policy while sharing the transport, encryption, and retry logic.

## Feature flags

| Feature | Default | Pulls in |
|---------|---------|----------|
| `http` | yes | `reqwest` — needed for `HttpPutDirect` and `TicketedPipeline` |
| `encrypt` | yes | `chacha20poly1305`, `base64`, `rand`, `zeroize` |

Disable both if you only need the destination trait + `LocalFsDestination` + `Cursor` + `jsonl`.
