# SQLite quarantine and recovery

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

## Offline recovery contract

`screenpipe db recover` requires Screenpipe to be stopped. `--force` cannot
override a reachable server because a live connection makes an exact generation
snapshot impossible.

1. Acquire the cross-process recovery lock and ensure durable quarantine exists.
2. Copy the DB/WAL/SHM bytes to a working directory without opening or
   checkpointing the quarantined generation. Compare file identity, length, and
   nanosecond modification time before/after the copy and again before swap; if
   anything changed, refuse recovery because the source was not truly offline.
3. Run SQLite `.recover` against only that working copy, producing a new file.
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
