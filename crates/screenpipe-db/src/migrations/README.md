# Database migrations

Add application schema changes as timestamped SQLx migrations in this directory.
Both ordinary SQLite databases and existing compressed databases run this same
migration set. Conversion preserves `_sqlx_migrations`, so SQLx applies only
pending files and owns their transactions, checksums, and completion records.
Keep applied SQL files immutable. Do not add feature-specific Rust migrations
or entries to `_hybrid_migrations`; that ledger describes the physical storage
format and its historical upgrades.

New resident tables automatically receive storage revision and privacy hooks
at startup. No recording rows are scanned to discover them. Internal tables
and the specialized capture/archive tables retain their existing hooks.

A migration that changes a logical table backed by compressed storage must
account for that physical layout. Test both database modes, including reopening
an older converted fixture and preserving its sealed history. SQLx tracks which
migration ran; it does not make arbitrary SQL compatible with virtual tables.
The old repair helpers in `db/setup.rs` still apply only to ordinary SQLite
or initial bootstrap.
