# Historical compressed database fixture

The ignored `historical_2_7_84_compressed_upgrade_preserves_data_and_restarts`
test uses a disposable synthetic database created and compressed by the actual
2.7.84 implementation at `8325934d5571b3d7d87ac068177d63c6dc5c9ce6`.
It does not open a user's Screenpipe database.

From the current repository, choose two new absolute paths outside the checkout:

```sh
old_checkout=/absolute/path/to/new-2.7.84-checkout
fixture_root=/absolute/path/to/new-synthetic-fixture
git worktree add --detach "$old_checkout" 8325934d5571b3d7d87ac068177d63c6dc5c9ce6
cp crates/screenpipe-db/tests/fixtures/build_2_7_84_upgrade_fixture.rs.txt \
  "$old_checkout/crates/screenpipe-db/tests/build_upgrade_fixture.rs"
(
  cd "$old_checkout"
  SCREENPIPE_UPGRADE_FIXTURE_ROOT="$fixture_root" \
    cargo test -p screenpipe-db --test build_upgrade_fixture -- --nocapture
)
SCREENPIPE_UPGRADE_FIXTURE_ROOT="$fixture_root" \
  cargo test -p screenpipe-db --features storage-fault-injection \
    --test hybrid_storage \
    historical_2_7_84_compressed_upgrade_preserves_data_and_restarts \
    -- --ignored --exact --nocapture
```

The builder refuses an existing destination. If interrupted, use a new path.
It creates 128 frames with Unicode text and accessibility trees, plus eight
rows each of audio transcripts, elements, UI events and meeting transcripts,
and a frame tag. It snapshots the records, runs the old compression migration,
and verifies the resulting payloads and migration ledger. Media paths are
placeholders; this fixture does not test audio or screenshot playback.

The current test copies the closed fixture to a temporary directory, runs normal
database startup, and verifies all historical rows, payloads and SQLx checksums.
It checks screen/audio search, stars, new capture writes, sealing, and two further
restarts. SHA-256 hashes verify that historical Parquet files stay unchanged and
that the original fixture is untouched. Startup runs in a spawned task to cover
the engine's `Send` requirement. The small fixture is a correctness check, not a
production-size performance benchmark.
