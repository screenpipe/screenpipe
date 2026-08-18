# SQLite quarantine and recovery

<!-- doc-covers: crates/screenpipe-sqlite-recovery, crates/screenpipe-sqlite-coordinator -->
<!-- doc-verified: 8be4d97b8 -->
> **Current.** Last verified against 8be4d97b8 (2026-08-03).

Screenpipe treats `SQLITE_IOERR`, `SQLITE_CORRUPT`, `SQLITE_FULL`, and
`SQLITE_NOTADB` as generation-ending faults. A new connection, pool, engine, or
app process is not recovery: it would still open the same physical database and
the same WAL generation.

## Runtime boundary

```text
SQLite hard fault
      |
      v
close the process-wide writer/checkpoint gate
      |
      v
atomically activate db.sqlite.quarantine.json
      |
      +--> stop capture and every owned SQLite pool
      |
      +--> all later managers and app launches fail closed
```

`db.sqlite.quarantine.reserve.json` is written while the filesystem is healthy.
The fault path renames that already-allocated file first, so a full filesystem
can still leave a durable fail-closed marker even if detailed JSON cannot be
allocated. The marker records the canonical path, SQLite extended result code,
time, and physical file identity:

- Unix: device and inode.
- Windows: volume serial number and file index.

The marker is separate from `db.sqlite`, `db.sqlite-wal`, and
`db.sqlite-shm`. Relaunching Screenpipe therefore does not forget the fault.
Malformed recovery metadata is also fail-closed.

## Authoritative file lifecycles

Capture and credentials deliberately do not share a journal:

```text
db.sqlite (high-write capture)          secrets.sqlite (credentials)
--------------------------------        ------------------------------
WAL journal                             rollback journal
read-only query pool                    one connection
coordinated writer capability           one coordinated writer gate
one checkpoint task                     no checkpoint task
PASSIVE / RESTART only                  synchronous = FULL
no live WAL truncation                  no WAL or shared-memory file
```

Every production credential caller resolves `secrets.sqlite` through
`SecretStore::open_for_data_dir`. On the first upgraded launch, legacy rows are
copied from `db.sqlite.secrets` and the completion marker is committed in the
same credential-database transaction. The legacy table remains unchanged for
downgrade safety. A quarantined legacy generation cannot be opened to perform a
first migration; after migration is complete, a capture quarantine does not
make already-separated credentials unreadable.

Live capture checkpoints use `PASSIVE` for routine copying and serialized
`RESTART` when all safe frames must reach the main file. No live path uses
`TRUNCATE`, changes journal mode, or attempts aggressive repair. Online repair
is rejected; physical cleanup and file replacement belong to offline recovery.

These properties are executable invariants. CI statically rejects production
WAL truncation and capture-pool credential construction, injects real IOERR and
SQLITE_FULL results through a VFS, and repeatedly kills child processes during
active writes, pinned reads, checkpoint waits, and post-checkpoint writes.

## Offline recovery contract

`screenpipe db recover` requires Screenpipe to be stopped. `--force` cannot
override a reachable server because a live connection makes an exact generation
snapshot impossible.

1. Acquire the cross-process recovery lock and ensure durable quarantine exists.
2. Copy the DB/WAL/SHM bytes to a working directory without opening or
   checkpointing the quarantined generation. Compare file identity, length, and
   nanosecond modification time before/after the copy and again before swap; if
   anything changed, refuse recovery because the source was not truly offline.
3. Run SQLite's official page-level Recovery API, compiled into Screenpipe,
   against only that working copy. Recovery never depends on a host `sqlite3`
   executable or package-manager installation.
4. Require the candidate's physical identity to differ from every quarantined
   identity.
5. Run `quick_check`, full `integrity_check`, and `foreign_key_check`.
6. Commit a recovery canary, close SQLite, reopen the file, read the canary,
   remove it, and repeat integrity and foreign-key checks.
7. Move the exact original DB/WAL/SHM into `db-recovery-*/source-generation/`
   and install the verified candidate at `db.sqlite`.
8. Repeat fresh-identity, integrity, foreign-key, and write-canary verification
   at the installed path.
9. Atomically archive the quarantine marker as `resolved-quarantine.json`.

The original generation is never checkpointed, truncated, or used as the
recovery destination. Quarantine clears only after a real write advances and is
read back from the verified replacement.

## Crash behavior

Each recovery phase writes a synced manifest. The durable marker blocks normal
startup throughout the operation. If the process dies while DB/WAL/SHM are
being moved, the next recovery invocation detects the partial archive and
restores the original coherent generation before starting a new attempt. A
normal install or post-install verification error also rolls the original files
back and leaves quarantine active.

Recovery artifacts are retained for inspection until the user runs
`screenpipe db cleanup --apply`. Cleanup refuses to delete recovery directories
while an active quarantine marker exists.
