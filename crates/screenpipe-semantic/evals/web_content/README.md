# New web app context coverage

Four new catalog profiles and dedicated parser registrations increase coverage
from 56 to 60 profiles and from 23 to 27 registered parsers. These are new apps,
not extra browser routes for already supported apps.

| App | Supported surface | Retained context |
|---|---|---|
| GitHub | github.com issue and pull-request conversation pages | Topic, source URL, description/comments, authors and attachment labels |
| GitLab | gitlab.com current issue/work-item detail pages | Topic, source URL, description and authored comments |
| Hacker News | `item?id=…` discussion pages | Story title, source URL, self-text and comments with authors |
| Wikipedia | Article paths under language subdomains | Heading, source URL and article text, including section headings |

Each parser requires its observed content markers. Missing markers, login screens,
drafts and previews abstain to generic accessibility; the shared family parsers
are deliberately not fallback candidates for these four profiles. Known-offscreen
text is suppressed by the existing capture adapter. A scrolled thread can retain
visible comments even when the title is no longer in the capture. Missing authors,
status and timestamps remain unknown. Comment order is not treated as reply
hierarchy: every post belongs to its observed discussion.

Source URLs omit fragments and queries except HN's required item id. Native post
ids distinguish equal text by different authors and deduplicate repeated wrappers.
Without a native post id, identity is explicitly ephemeral. Nested Markdown wrappers
do not duplicate paragraphs. Known control labels are removed only under controls;
links, attachment names, authored action words and code indentation remain.
A shared 32 KiB body budget and 64-post limit keep output within the default
projection budget. Truncation is explicit in context metadata.

## Evidence and limits

The following public page DOM structures were inspected in a task-owned hidden
browser on September 21, 2026. These links document the source of the structural
contracts, not a live native-capture accuracy measurement.

- [GitHub issue](https://github.com/laurent22/joplin/issues/10795):
  `react-issue-body`, `react-issue-comment`, nested `markdown-body`, `markdown-title`
  and author CSS-module prefixes.
- [GitHub pull request](https://github.com/screenpipe/screenpipe/pull/7167):
  `timeline-comment`, `js-comment-body`, `author`, `markdown-title`; preview bodies
  and composer content are excluded.
- [GitLab work item](https://gitlab.com/gitlab-org/gitlab/-/work_items/364818):
  `gl-heading-1`, `work-item-description`, `note-comment`, `note-text`,
  `author-name-link`. The old `/issues/` URL redirected to `/work_items/`.
- [Hacker News discussion](https://news.ycombinator.com/item?id=1):
  `fatitem`, `titleline`, `toptext`, `comtr`, `commtext`, `hnuser`.
- [Wikipedia article](https://en.wikipedia.org/wiki/Computer_programming):
  `firstHeading`, `mw-content-text`, `mw-parser-output`. Edit links, navigation
  boxes, sidebars and portals are excluded.

`cases.json` is hand-authored synthetic data using those shapes and invented
content. Tests replay through the capture adapter and real registry with macOS,
Windows and Linux identities/role variants. They do not prove that every native
browser walker supplies those DOM attributes. The subsequent isolated AWS Mac
and Azure Windows campaign exercised the production native walkers. See
[NATIVE_VALIDATION.md](NATIVE_VALIDATION.md) for observed results, fixes and limits.

Not covered: GitHub source/diff tabs, GitLab merge requests, self-hosted GitHub or
GitLab, HN listing pages, Wikipedia namespace pages or percent-encoded article
paths. Wikipedia's English main page abstains. Stack Overflow was not added:
its page presented a browser challenge, so its DOM contract was not verified.

## Reproduce

```sh
cargo test -p screenpipe-semantic --test web_content --locked
cargo run --release -p screenpipe-semantic --example web_content_eval --locked
```

The five fixtures have 60 exact field/relationship and exclusion assertions, all
passing. The same gold is checked across three platform identities; that does not
make these 180 independent facts. Regression tests additionally cover
routing, abstention, scrolled/unknown fields, stable identity, repeated wrappers,
bounded multibyte output and control reparenting.

| Fixture | Assertions | Raw JSON tokens | Context tokens |
|---|---:|---:|---:|
| GitHub issue | 15/15 | 413 | 74 |
| GitHub pull request | 9/9 | 267 | 44 |
| GitLab work item | 13/13 | 251 | 58 |
| Hacker News discussion | 15/15 | 409 | 76 |
| Wikipedia article | 8/8 | 215 | 45 |
| Total | **60/60** | **1,555** | **297** |

Exact `o200k_base` counts: context uses 80.9% fewer tokens than the serialized
accessibility fixture JSON. This is a representation comparison, not a reduction
against a previously supported semantic parser, and not a model-quality score.
The source URL is retained once per page because provenance is useful context.
