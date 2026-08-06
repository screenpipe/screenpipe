# search e2e specs

E2E specs that drive the Search window against **real seeded data** (no network
or fetch stubbing).

## Fixture

The specs require the app to be launched with the `search-fixture` seed flag:

```
SCREENPIPE_E2E_SEED=onboarding,no-recording,search-fixture
```

That flag is handled in `src-tauri/src/e2e/seeds.rs` (`seed_search_fixture`),
which inserts known searchable frames via `insert_snapshot_frame_with_ocr`:

- 12 frames whose OCR text contains **"vector"** — enough to exercise the
  results grid layout.
- 1 frame containing **"cat concatenate vectorization"** with per-word bounding
  boxes, for the highlight over-match case.

`full_text` is FTS-indexed (so `/search/keyword` returns the frames) and
`text_json` holds the per-word boxes (so `/frames/{id}/text` drives the
highlight overlay). Specs self-skip when the flag is absent.

## Running

```
# from apps/screenpipe-app-tauri
bun run test:e2e:search-bugs
```

The script sets `SCREENPIPE_PORT` to a non-default port so the harness app
boots its own server even on a dev machine already running screenpipe on
`:3030`. Add `RECORD_VIDEO=1` to capture an mp4 under `e2e/videos/`.

## Specs

- `search-bugs-4645.spec.ts` — reproduces the grid-reflow bug from #4645: on a
  wide window the results grid stays at 3 columns (hard-coded `grid grid-cols-3`)
  instead of showing more thumbnails. Verified RED against current `main`.

Not yet covered here (tracked in #4645):

- **highlight over-match** (`ThumbnailHighlightOverlay` uses
  `text.includes(term)`) — wasn't reproducible deterministically via the
  rendered overlay; likely better as a unit test of the matcher, or needs
  root-cause work.
- **occurrence arrows, frame-preview text selection, URL/frame off-by-one** —
  live in the post-navigation timeline view, which needs a decodable
  video/snapshot frame fixture to render.
