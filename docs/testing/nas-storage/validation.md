# macOS NAS migration and recording validation

<!-- doc-covers: crates/screenpipe-fs, crates/screenpipe-db/src/storage, crates/screenpipe-db/src/db/setup.rs, crates/screenpipe-sqlite-coordinator/src/verification.rs, crates/screenpipe-screen/src/snapshot_writer.rs, crates/screenpipe-audio/src/audio_manager/reconciliation.rs, apps/screenpipe-app-tauri/components/storage-migration-prompt.tsx -->
<!-- doc-verified: c87fa3e65dc39ca93a65dc7865fe2266c886eab7 -->

Run: `nas-cede-20260918`, 2026-09-18 UTC. Baseline `c88ffa4b2d`;
product candidate `c87fa3e65d` (consumer 2.7.51).

The supplied 2.7.42 feedback showed a custom `/Volumes/...` data directory and
startup stuck in database migration. It did not include the native syscall
failure. The failures below were reproduced independently on a real SMB mount;
no customer database, account, or recordings were used or changed.

## Reproduction and cause

A fresh SIP-disabled macOS 26.6.2 (25G83) Tart guest mounted a Samba 4.19.5
SMB3 share from a disposable Ubuntu ARM64 VM. Both ran on the same Orchard Mac
worker. Guest isolation required an owned TCP relay on the VM gateway; this
was real macOS `smbfs`, not a mocked filesystem. The small storage test share
was a marked 512 MiB ext4 loop volume (487 MiB reported by SMB). Desktop tests
used a separate 35 GiB share with over 30 GiB free and a 110 GiB Mac guest
with over 70 GiB free locally.

[Filesystem probe](filesystem-probe.txt) and [baseline failure](baseline-smb.txt):

```text
F_FULLFSYNC -> ENOTSUP (45); fsync(file) and fsync(directory) -> success
F_PUNCHHOLE -> ENOTSUP (45)
baseline -> failed to arm SQLite verification incident:
            Operation not supported (os error 45)
```

Three independent incompatibilities had to be resolved:

1. Rust 1.94 uses `F_FULLFSYNC` for both `File::sync_all` and `sync_data` on
   Darwin. The NAS rejects this device-cache operation. The shared durability
   helper falls back to `fsync` only for Darwin ENOTSUP and propagates a failed
   fallback and all other I/O errors. Capture JPEGs, Parquet files, migration
   descriptors, verification markers, source identity, pending audio, settings,
   and connection configuration use this helper.
2. SMB rejects hole punching. Reclamation is now optional while the existing
   batch reserve and bounded in-place conversion remain mandatory. SQLite free
   pages stay available for reuse. There is no second database copy or VACUUM.
3. Forced `unix-excl` POSIX byte locks fail with `SQLITE_IOERR_LOCK` (3850).
   The default macOS VFS selects filesystem-aware locks. Its NAS path cannot
   reopen a shared-memory WAL (`SQLITE_CANTOPEN`, 14), so migration and runtime
   both use DELETE journaling and FULL synchronization on network volumes.
   Local volumes retain their existing VFS and WAL policy.

Legacy NAS WAL verification uses a SQL read-only barrier, an exclusive private
WAL index, and `NO_CKPT_ON_CLOSE`. The test byte-compares the database and hot,
committed WAL before/after verification, then proves normal recovery can adopt
those rows in rollback mode. Operational errors remain availability failures,
not evidence of corruption. The existing manager ownership and single writer
remain in place; this does not enable sharing one live database between Macs.

## Changed behavior

| Check | Result and evidence |
| --- | --- |
| Original unsupported operation | FAIL on baseline; preserved [failure log](baseline-smb.txt) |
| In-place conversion on non-sparse SMB | PASS: 48 historical frames and 48 elements; completion receipt present; migration journal removed |
| Recording after conversion and reopen | PASS: new frame, element and transcript sealed, searchable, exact payloads retained, `integrity_check=ok`; [log](migration-smb.txt) |
| Legacy committed WAL after process death | PASS: verifier leaves DB/WAL bytes unchanged, pending verification recovers, old/new rows survive reopen; [log](legacy-wal-smb.txt) |
| Migration/sealing process crashes | PASS: all 12 existing crash boundaries exercised on SMB; acknowledged rows survive resumed conversion; [log](crash-recovery-smb.txt) |
| Connection settings on SMB | PASS: create, replace and delete through the existing connection store |
| Ordinary app migration, capture and restart | Desktop acceptance recorded below |

The non-sparse test deliberately uses zero disk reserve and 1 MiB batches on
its disposable <=512 MiB share. Desktop acceptance uses production migration
budgets with no disk-pressure override. On the small share, source allocation
was 48,115,712 bytes, resulting index allocation 48,881,664 bytes and Parquet
154,176 bytes. This filesystem did **not** return SQLite free pages to the OS.
The prompt now explains reuse and reports measured savings without promising
that every NAS database file shrinks.

## Local checks

All commands run from the repository root unless an app-directory command is
shown. Hardware-specific NAS tests stay ignored in ordinary CI.

```sh
cargo test -p screenpipe-fs -p screenpipe-sqlite-coordinator --lib
# 3 durability + 27 coordinator tests passed
cargo test -p screenpipe-db --features storage-fault-injection --lib storage:: -- --nocapture
# 25 passed, 2 hardware-specific ignored
cargo test -p screenpipe-db --features storage-fault-injection \
  --test in_place_migration --test hybrid_storage --test bulk_storage \
  --test storage_snapshots --test sqlite_architecture_invariants_test \
  --test db_config_test --test multi_pool_wal_parity_test -- --nocapture
# 52 passed, 5 hardware-specific ignored
cargo test -p screenpipe-connect --lib mcp_servers::tests:: -- --nocapture
# 25 passed
cd apps/screenpipe-app-tauri
NODE_OPTIONS=--no-experimental-webstorage bun run test:vitest components/storage-migration-prompt.test.tsx
# 17 passed; Node 26 Web Storage otherwise masks jsdom localStorage
bun run build:tauri:e2e
# Packaged consumer debug-dev E2E build through the native queue and sccache
bun run coverage:all:check
# E2E, core and unified coverage reports passed
cd ../..
bun scripts/check-doc-freshness.ts --check
# Passed: no undeclared specs
git diff --check
# Passed
```

The E2E queue command was temporarily changed from `--no-bundle` to
`--bundles app` solely to package this test app. That harness edit and generated
E2E schemas are excluded from the PR. The source artifact was Apple Development
signed, verified, checksummed, and stored in a private Azure Blob container with
server-side encryption. Only the disposable guest copy was re-signed with
`tcc-grant --adhoc-sign`; all four capture permissions plus Full Disk Access
were granted. Feature-only onboarding and account fixtures bypass authentication;
they do not prove login, billing, cloud AI, or hosted enterprise ingest.

A paired APFS flush microbenchmark (ten alternating rounds, 100 4 KiB overwrites
per round) measured median 4.8225 ms before and 4.8559 ms after (+0.7%), with
substantially overlapping samples. [Raw samples](local-flush-benchmark.txt) and
[benchmark source](flush-benchmark.rs) are included. This is the changed flush
primitive, not a claim about end-to-end NAS throughput. Local successful flushes
add no filesystem lookup, allocation, or syscall. NAS latency depends on the
network and server; successful flush durability depends on the server.

## Repeating the NAS tests

Use only an owned disposable share with `.screenpipe-disposable-volume` at its
root. Compile the normal macOS test executables with the commands above and
transfer them to the Mac guest. The fixture code and [filesystem probe](filesystem-probe.py)
are included. The baseline test is named `unsupported_volume_fails_before_conversion`.

```sh
SCREENPIPE_UNSUPPORTED_VOLUME=/Volumes/Screenpipe ./in_place_migration \
  non_sparse_volume_migrates_and_keeps_recording_after_restart --ignored --exact --nocapture
SCREENPIPE_UNSUPPORTED_VOLUME=/Volumes/Screenpipe ./in_place_migration \
  network_wal_verification_and_reopen_preserve_committed_rows --ignored --exact --nocapture
TMPDIR=/Volumes/ScreenpipeApp/tests ./hybrid_storage \
  migration_crashes_resume_without_losing_acknowledged_records --exact --nocapture
```

The hybrid crash test launches `screenpipe-storage` from its compile-time path;
install the matching CLI there inside the disposable guest. The desktop legacy
history fixture uses the production database writer; its eight synthetic rows
and placeholder JPEG are distinct from the subsequent real TextEdit captures.

## Desktop acceptance

The packaged app used product commit `c87fa3e65dc39ca93a65dc7865fe2266c886eab7`.
This is the NAS acceptance build. Subsequent CI repairs update test fixtures,
the Intel smoke build's sidecar selection, and Windows recovery-owner detection;
they do not change the NAS filesystem or migration implementation. Their check
results are recorded in PR #7090. The private source bundle SHA-256 is
`5da727e13a7d3a6bfbfb898cccce3e023bb208f6bb2df3d9118d06052b1f5b16`.
The 53-second migration video SHA-256 is
`5dddb3f77dfe7b49a18f59381327ab5e2beca436022f1b4e290ce2e329372d2b`.
Both objects are in a private, server-encrypted Azure container. The PR includes
a read-only video link expiring September 24, 2026; the app bundle stays private.

The app's `SCREENPIPE_DATA_DIR` was `/Volumes/ScreenpipeApp/Mac Mini`. Clicking
**Start now** migrated 332 records, including 23 frames, in 19 seconds. This
included eight synthetic legacy frames and real TextEdit captures. The
[completion receipt](native-completion-receipt.json) was present, the in-place
journal was absent, and [native status](native-migration-status.json) reported
`completed=true`, `using_new_storage=true`, `pending=false`, with no error.
Allocated storage grew from 6,037,504 to 6,944,768 bytes; the app correctly
reported zero bytes saved on this non-sparse share.

The PR embeds the before/after screenshots (`migration-before.png` and
`migration-complete.png`) and links the migration recording. Media is hosted
externally, as required by the PR template.

After conversion, actual TextEdit accessibility text and JPEGs continued writing
to the NAS. A 10-second relay pause from 06:31:17 to 06:31:27 UTC exercised a
bounded transport stall. [Post-stall counters](native-after-stall-health.json)
reported 12 captured frames, 12 database writes, zero drops, zero silent loss,
and no degraded writer. Frame 37, captured during the pause, remained readable
after restart. This was a transport stall, not an unmount or server power-loss
test.

The normal native `stop_screenpipe` command drained recording and closed the
pools; the owned app process was then terminated and relaunched with the same
data directory. Offline `screenpipe-storage verify` returned `{"verified":true}`
both before this restart and after final shutdown. The restarted app retained
the same storage generation and reached `ready` without rerunning migration:
[restart status](native-restart-status.json).

[Authenticated API results after restart](native-restart-search.json) contain
all eight legacy rows, pre-restart frames 35–38, new post-restart frames, and the
NAS audio transcript. The real Search card opened frame 47 in the native
Timeline; [native readback](native-timeline-state.json) confirms current,
displayed, and loaded-image frame IDs all equal 47. The screenshot shows the
captured `NASNETWORKRETURN` and `NASPOSTMIGRATIONCONFIRMED` markers:

The PR embeds `timeline-new-recording.png`, the actual native Timeline display.

The final [restart health](native-restart-health.json) reports 18 captured and
18 written frames, no dropped frames or writer failures, and active UI-event
recording. Its overall health is **degraded for audio**, not an all-green pass.

### Audio result and testing limits

Through the real settings UI, audio recording was enabled and Whisper Tiny
selected. Synthetic speech played inside the VM through CoreAudio. Raw system
audio was saved on the NAS; a 30.01-second file decoded successfully, with peak
volume -3.3 dB. The automatic VAD rejected the synthetic input, so automatic
transcription was not proven. There were no audio processing or storage errors.

The normal `/audio/retranscribe` API with Whisper Tiny processed five recorded
chunks and transcribed the audible chunk successfully:
[retranscription result](audio-retranscription.json). Its transcript and NAS file
remained searchable after restart. This proves actual audio capture, NAS file
read/decode, local transcription, database persistence, and search/reopen; it
does not claim automatic VAD acceptance or cloud transcription.

The first fixture mount detached when SMB multichannel attempted an unreachable
guest-to-guest route around the required relay. The source database remained
intact. Disabling multichannel on the disposable client and server corrected
that test-network configuration before the final acceptance run. No product
code was changed for that routing problem. Search was refreshed after its
normal indexing exclusion window; the backend and native Timeline were tested
with actual persisted frames.

## Cleanup

The app was stopped and the final database verified before teardown. Orchard
deleted exactly `nas-cede-mac-20260918` and `nas-cede-smb-20260918`. Orchard and
the worker's Tart inventory confirmed both gone. The owned TCP relay process
and script were removed, port 1445 had no listener, and the run lock was
released. The original `aws-orchard` context was unchanged. VM deletion removed
the synthetic account fixture, local API key, imported test app, data volumes,
and ephemeral SSH authorization. Base images and unrelated stopped VMs were
left intact. No host application was launched or stopped.

This validates macOS SMB against the described Samba server. The customer's
macOS 27 installation and NAS firmware were not directly available. NFS,
Windows NAS mounts, server power loss, and concurrent multi-host ownership were
not tested. Existing APFS behavior and typed I/O error propagation were tested
locally. No app release or updater pointer was published.
