# Native capture validation

On September 21, 2026, an isolated AWS `mac-m4pro.metal` machine running macOS
15.7.9 (24G830), with SIP enabled, captured real accessibility trees through the
production `semantic_capture_probe`. Safari 26.6.1 visited public GitHub,
GitLab, Hacker News and Wikipedia pages. TextEdit 1.20 and Terminal displayed a
synthetic local document. No personal desktop or release machine was used.

The same seven private capture records were replayed at `d00a8e2deb` and
final parser commit `9f17d2a5f9` on a local Mac. The five browser surfaces previously abstained; the updated parsers
handle all five. Existing TextEdit and Terminal handling remains successful.
The native Mac capture code tested at `1ece5c01a6` remains unchanged by the Windows fixes.

| Native surface | Before | After | Context tokens | Known offscreen nodes excluded |
| --- | --- | --- | ---: | ---: |
| GitLab work item, top | Not handled | Title, author, visible description | 280 | 344 |
| Wikipedia article, top | Not handled | Title and visible article text | 355 | 1,613 |
| Wikipedia article, scrolled | Not handled | Visible section, no invented title | 722 | 1,564 |
| GitHub PR conversation, top | Not handled | Title, author, visible description | 164 | 373 |
| Hacker News discussion | Not handled | Story title and three attributed comments | 83 | 0 |
| TextEdit synthetic document | Handled | Handled, code indentation retained | 85 | 0 |
| Terminal synthetic output | Handled | Handled, code indentation retained | 279 | 0 |

There are **69/69 bounded checks** across these records for extracted facts,
item counts, attribution, authored text, code indentation, absent toolbar/sidebar
noise and parser failures. These are observations from seven surfaces, not a
population-wide accuracy estimate. See [sanitized metrics](native-macos-metrics.json).
Raw JSON token counts include structural and offscreen nodes; their reduction
measures representation size, not improvement over a previous semantic parser.

The live captures exposed and drove these corrections:

- WebKit omits inert DOM wrappers. Recognize bounded native structures for
  GitHub comment headers/end markers, GitLab description/sidebar boundaries,
  Hacker News sibling headers/bodies and Wikipedia article bodies.
- Preserve native proof that a positive-sized rectangle lies outside the
  window even when screenshot coordinate normalization discards its bounds.
  Zero-sized accessibility labels remain unknown visibility and fail open.
- Retain table column structure so duplicate row/column/header views are
  excluded without deduplicating repeated authored cells.
- Do not convert generic accessibility role descriptions into authored text;
  exclude recognized section-edit controls while retaining authored words.

Synthetic regressions model these observed structures in `tests/web_content.rs`
and `tests/capture_adapter.rs`. Raw probe output is deliberately not committed.

For new private captures, build the production probe on macOS or Windows, focus
an intended app, and run:

```sh
cargo run -p screenpipe-a11y --example semantic_capture_probe -- --delay-secs 5 > native.jsonl
cargo run -p screenpipe-semantic --example replay -- --jsonl < native.jsonl
# Explicit opt-in to inspect authored content; keep this output private too.
cargo run -p screenpipe-semantic --example replay -- --jsonl --include-context < native.jsonl
```

The AWS machine also ran the 162 semantic tests and the focused native geometry
and transient-serialization tests at `1ece5c01a6`. All passed. Local validation
included semantic library Clippy with warnings denied and the engine library
integration check.

## Windows

An isolated Azure Windows 11 VM (`Standard_DC8s_v3`, East US) used the prepared
Windows dev image and its own console session. Edge visited the same four public
pages. The first native capture at `d00a8e2deb` supplied AutomationId/ClassName
properties but discarded semantic containers/DOM fields: all four web parsers
abstained. The opt-in Windows path now retains that evidence and uses a bounded
RawView walk where Chromium's ControlView omits required content boundaries.
The ordinary capture path remains unchanged.

Native tests and fresh captures at **`9f17d2a5f9`** passed **169 semantic tests**,
**12 focused Windows a11y tests**, all four evals, semantic library Clippy and
diff checks. Independent replay passes **62/62 bounded checks** across the four
web surfaces, scrolled Wikipedia and a semantic-off control. See
[sanitized Windows metrics](native-windows-metrics.json).

| Native surface | Final result | Context tokens | Known offscreen nodes excluded |
| --- | --- | ---: | ---: |
| GitHub PR conversation, top | Title, local author and visible body | 130 | 56 |
| GitLab work item, top | Title, verified creator and description | 228 | 72 |
| Hacker News discussion | Title and three correctly attributed comments | 85 | 0 |
| Wikipedia article, top | Title and introductory article text | 206 | 0 |
| Wikipedia article, scrolled | Safely abstains | N/A | 209 |
| Edge semantic-off control | Legacy tree, no transient DOM/visibility fields | N/A | 7 |

These are separate live before/after captures, not a same-input token or speed
benchmark. Every semantic-on browser capture reached the unchanged 250 ms walk
budget. The scrolled ControlView control confirms that the viewport showed the
Efficiency/performance section, while RawView exhausted its budget before reaching
that verified body. The parser therefore abstains. It no longer emits the
incorrect offscreen title/introduction observed in the first Windows fix. This
is a correctness improvement, not complete deep-scroll coverage.

Native findings also drove synthetic regressions for combined semantic and
automation flags, finite positive off-window geometry versus unknown/zero
geometry, GitHub aggregate/link duplication, authored repeated paragraphs,
control-label exclusion, and complete bounded HN fragments with local identity
evidence. Six independent synthetic review checks improved from **2/6 to 6/6**;
these are deliberately separate from the live-capture checks. The original
partial-parent/link/suffix case remains supported, and code indentation is
preserved. The seven Mac records still pass **69/69** checks at this final parser
revision.

A separate final Notepad capture at `9f17d2a5f9` passed all 11 VM focus/content
assertions and 11 independent replay checks. The foreground HWND and process
were verified as Notepad, with no browser URL. The native walk completed in
112 ms without truncation; one document retained the synthetic marker, owner,
in-progress status, authored Copy/Reply words and code indentation in 76 context
tokens. These checks are separate from the 62 web/control checks above.

Raw captures, authored replay output and desktop recordings remain private.
Only synthetic regression fixtures and sanitized metrics are committed. Existing
release builders and other workflows were not modified.
