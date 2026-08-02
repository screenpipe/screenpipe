# SQLite recovery extension

Screenpipe vendors SQLite's public-domain recovery extension from the official
SQLite `version-3.51.3` source tag. This exactly matches the SQLite version
bundled by the workspace's pinned `libsqlite3-sys = 0.37.0` dependency.

Source archive:

`https://sqlite.org/src/tarball/sqlite.tar.gz?r=version-3.51.3`

Vendored upstream files and SHA-256 digests:

- `dbdata.c`: `0a57eae22b51507c28f6c647fba00ccacd39b5aaf3393dfe9435fb04810a6e0e`
- `sqlite3recover.c`: `bc56c1131dfdc979fd93a7e013856f4c2a98570c722c069600f6c66d2d47743f`
- `sqlite3recover.h`: `c088088d15af055304e931842f7c197024d46ff1b7077912ec42149e9fa4f9bb`

When the bundled SQLite version changes, replace these files from the matching
official SQLite tag, update the digests above, and run the recovery tests on
macOS, Windows, and Linux. The extension requires
`SQLITE_ENABLE_DBPAGE_VTAB`; the workspace config enables it for the bundled
SQLite compilation.
