# Single-Click Summaries — Product Spec

<!-- doc-covers: apps/screenpipe-app-tauri/components/chat -->
<!-- doc-verified: 3606788c6 -->
> **Historical.** Last verified against 3606788c6 (2026-02-19). `apps/screenpipe-app-tauri/components/chat` has moved a long way
> since; read this for original intent only. Names, signatures, and thresholds are
> probably wrong. The code wins. Run `bun scripts/check-doc-freshness.ts` for current drift.

**Author:** Louis / Menelaus (znitchi)
**Date:** Feb 19, 2026
**Status:** Draft

---

## Problem

Screenpipe records everything you see, say, and hear — but most users never ask the AI anything meaningful. The current empty chat state shows a few auto-suggestions ("What did I do in the last hour?"), but they're small, text-only, and easy to ignore. Users who don't know what to ask just stare at the input box and leave.

**Evidence:**
- Auto-suggestions exist (via `suggestions.rs`) but are small text buttons at the bottom of the empty chat
- The PI agent is powerful but requires users to formulate their own prompts
- Daily Summary exists but is limited to timeline view, auto-triggers only at 6 PM, and only covers audio transcriptions
- Menelaus (power user): "A lot of users might not know what to ask but having these auto-suggestions and one-click prompts makes everything a lot easier"

**Core tension:** Screenpipe collects 2K-13K+ memories per day, but the value is locked behind a blank text box.

---

## Solution

**"Single-Click Summaries"** — a prompt template library and visual builder that makes screenpipe's value immediately obvious. Instead of a blank chat, users see curated one-click actions that generate structured summaries from their data.

Menelaus calls this an "Enhanced AI Prompt Builder" — consumer-friendly, visually pleasing, accessible to non-technical users.

---

## User Value

| Summary | Value to User |
|---------|--------------|
| **Day Recap** | End-of-day reflection, "what did I actually accomplish?" |
| **Standup Update** | Copy-paste ready standup for team meetings |
| **Morning Brief** | Catch up on yesterday's unfinished work |
| **Time Breakdown** | Understand where time went (by app, by project) |
| **What's Top of Mind** | Surface recurring topics you keep coming back to |
| **AI Habits** | Track which AI tools you use, how much, patterns |
| **Custom Summary** | Power-user builder with time/app/website filters |
| **Collaboration Patterns** | Who you interact with most (Slack, meetings) |
| **Professional Persona** | Work style analysis for self-improvement |
| **Week Recap** | Weekly review without manual journaling |

**Key insight from Menelaus:** He mostly uses Time Breakdown, Day Recap, and AI Habits — the ones that answer "what did I actually do?" without requiring the user to remember.

---

## Design

### Component 1: Pre-Chat Landing Page

Replaces the current empty chat state. Shows before any conversation is initiated.

```
┌─────────────────────────────────────────────┐
│                                             │
│          [PI icon]                          │
│    How can I help today, {name}?            │
│                                             │
│  ┌─────────────┐ ┌─────────────┐ ┌────────────────┐
│  │ 📋 Day      │ │ 🏢 Standup  │ │ ✨ Custom      │
│  │ Recap       │ │ Update      │ │ Summary        │
│  │ Today's     │ │ What you    │ │ Custom time,   │
│  │ accomplish- │ │ did, next,  │ │ filters &      │
│  │ ments...    │ │ blockers    │ │ instructions   │
│  └─────────────┘ └─────────────┘ └────────────────┘
│  ┌─────────────┐ ┌─────────────┐ ┌────────────────┐
│  │ ❗ Top of   │ │ 🤖 AI      │ │ 🔍 Discover    │
│  │ Mind        │ │ Habits      │ │ Reminders,     │
│  │ Recurring   │ │ AI usage &  │ │ Recaps, and    │
│  │ topics...   │ │ model pref  │ │ More...        │
│  └─────────────┘ └─────────────┘ └────────────────┘
│                                             │
│  ┌─────────────────────────────────────────┐│
│  │ Ask about your screen activity...       ││
│  └─────────────────────────────────────────┘│
└─────────────────────────────────────────────┘
```

**Behavior:**
- Cards are larger and more prominent than current auto-suggestion chips
- Clicking a card immediately sends the corresponding prompt to PI agent
- "Discover" opens the full library modal (Component 2)
- "Custom Summary" opens the builder modal (Component 3)
- Chat input remains at the bottom — this doesn't block regular usage
- Once a message is sent, the landing page disappears (same as current behavior)

**Which 5 cards to feature?** Based on Menelaus' usage data:
1. Day Recap (most universal)
2. Standup Update (work context)
3. Custom Summary (power users)
4. What's Top of Mind (reflection)
5. AI Habits (meta-awareness)
6. Discover (gateway to full library)

### Component 2: Summary Library Modal ("Discover")

Full library of all templates, opened from the "Discover" card or a menu button.

```
┌─────────────────────────────────────────────────┐
│  Single-Click Summaries                    [X]  │
│                                                 │
│  The easiest way to leverage your artificial    │
│  memories. Access a growing library of          │
│  single-click summaries...                      │
│                                                 │
│  ┌──────────────────┐  ┌──────────────────┐     │
│  │ ❗ What's Top of │  │ 🌅 Morning Brief │     │
│  │ Mind             │  │ Everything to    │     │
│  │ Recurring topics │  │ kickstart your   │     │
│  │ ranked by import │  │ day              │     │
│  │    [See action]  │  │    [See action]  │     │
│  └──────────────────┘  └──────────────────┘     │
│  ┌──────────────────┐  ┌──────────────────┐     │
│  │ 🏢 Standup       │  │ ⏱ Time          │     │
│  │ Update           │  │ Breakdown        │     │
│  │ ...              │  │ ...              │     │
│  └──────────────────┘  └──────────────────┘     │
│  ... (2-column grid, all 10 templates)          │
└─────────────────────────────────────────────────┘
```

**Behavior:**
- Scrollable 2-column grid of all templates
- Each card has: icon, title, description, "See it in action" link (YouTube demo)
- Clicking a card sends the prompt and closes the modal
- "Custom Summary" card opens the builder (Component 3) instead

### Component 3: Custom Summary Builder

Advanced modal for power users. The main differentiator from simple one-click templates.

```
┌───────────────────────────────────────────────────────────┐
│  ✨ Custom Summary                                  [X]  │
│                                                           │
│  ┌─ Left Panel ──────┐  ┌─ Right Panel ────────────────┐ │
│  │                    │  │                              │ │
│  │ ⏰ Time Period [1] │  │ What should the summary      │ │
│  │                    │  │ focus on?                    │ │
│  │  Last 5 min     9  │  │                              │ │
│  │  Last 30 min   61  │  │ ┌──────────────────────────┐ │ │
│  │  Last 2 hours 479  │  │ │ Type your custom         │ │ │
│  │  ✓ Today    2.6K  │  │ │ instructions for 2.82K   │ │ │
│  │  Past 24h     3K  │  │ │ memories from today...   │ │ │
│  │  Yesterday  1.4K  │  │ │                          │ │ │
│  │  This Week  8.9K  │  │ │                          │ │ │
│  │  Last Week  4.2K  │  │ │                          │ │ │
│  │  This Month 13.1K │  │ │                     0/1K │ │ │
│  │  Last Month       │  │ └──────────────────────────┘ │ │
│  │                    │  │                              │ │
│  │ 📡 Signals    [v] │  │  QUICK TEMPLATES             │ │
│  │ 📱 Apps       [v] │  │  [Status Update]             │ │
│  │ 🌐 Websites   [v] │  │  [Key Decisions]             │ │
│  │                    │  │  [Action Items]              │ │
│  └────────────────────┘  │  [Meeting Prep]              │ │
│                          │  [Blockers]                  │ │
│                          └──────────────────────────────┘ │
│                                                           │
│  Processing 2.82K memories from today                     │
│                        [Save as Template] [✨ Generate]   │
└───────────────────────────────────────────────────────────┘
```

**Left Panel — Filters:**
- **Time Period:** Predefined ranges with live memory counts from screenpipe DB
- **Signals:** Filter by content type (OCR, audio, UI/accessibility) — maps to `content_type` in search API
- **Apps:** Multi-select app filter (from recorded apps) — maps to `app_name`
- **Websites:** Multi-select website/URL filter — maps to `window_name` or new `browser_url` field

**Right Panel — Prompt Builder:**
- Free-text instructions (1000 char limit)
- Quick template chips that pre-fill the text area
- Placeholder shows memory count for selected time range

**Bottom Bar:**
- Live count: "Processing X memories from {period}"
- "Save as Template" — saves to user's custom templates (local storage or pipes)
- "Generate Summary" — sends filtered prompt to PI agent

---

## How It Works (Technical Flow)

### One-Click Summary Flow
```
User clicks "Day Recap"
  → Frontend builds prompt: system context + template prompt + time filter
  → Sends to PI agent via sendPiMessage()
  → PI queries /search API with time range + content filters
  → PI generates structured summary
  → Response streams into chat
```

### Custom Summary Flow
```
User configures filters + instructions
  → Frontend builds search query from filters
  → Pre-fetches memory count: GET /search?count_only=true&start_time=X&end_time=Y
  → On "Generate": sends compound prompt to PI agent
  → Prompt includes: time range, app filter, content type, user instructions
  → PI agent executes search + generates summary
  → Response streams into chat
```

### Memory Count Query
Each time period / filter selection triggers a lightweight count query:
```
GET /search?start_time={ISO}&end_time={ISO}&app_name={filter}&limit=0&count_only=true
```
This powers the "2.82K memories from today" indicator. Uses existing search API — may need a `count_only` param to avoid returning full results.

---

## Prompt Templates

Each template is a structured prompt sent to the PI agent. Templates include:

### Day Recap
```
Analyze my screen and audio recordings from today.
Provide: a one-line summary, top 3 accomplishments,
key moments with timestamps, and any unfinished work.
Format as structured sections.
```

### Standup Update
```
Based on my recordings from the last 24 hours, generate
a standup update: What I did yesterday, what I'm working
on today (based on recent activity), and any blockers
(meetings that ran over, errors encountered, etc).
```

### Time Breakdown
```
Analyze my app usage and screen recordings from today.
Break down time by: application, project/topic, and
category (coding, meetings, browsing, writing, communication).
Show percentages and durations.
```

### AI Habits
```
Search my recordings for AI tool usage: ChatGPT, Claude,
Copilot, Cursor, Gemini, and other AI assistants.
Report: which tools I used, approximate time per tool,
what I used them for, and patterns in my AI usage.
```

*(Full prompt library would be maintained as a JSON/config file)*

---

## Edge Cases & Considerations

### Data Availability
- **New user (no data):** Show templates grayed out with "Start recording to unlock summaries" message. Don't show memory counts of 0 — it's discouraging.
- **Partial data (OCR only, no audio):** Templates that rely on audio (Meeting Prep, Collaboration Patterns) should indicate "Audio recordings not available" and adapt.
- **Very old time ranges:** "Last Month" with 13K memories — the PI agent may hit token limits. Need to either pre-filter/sample or chunk the query.

### Performance
- **Memory count queries:** Must be fast (<100ms). Current `/search` returns full results — need lightweight count endpoint or cache layer.
- **Large result sets:** PI agent's search skill caps at 10 results / 4000 chars. For "Time Breakdown" across a full day, this may be insufficient. Consider: (a) multiple search passes, (b) pre-aggregated stats endpoint, (c) SQL-based aggregation.
- **Concurrent requests:** User clicks multiple templates quickly — debounce or queue.

### Template Quality
- **Generic prompts produce generic results.** Templates must include specific instructions: "include timestamps", "group by app", "show duration in hours:minutes".
- **Hallucination risk:** PI agent might fabricate activities not in the data. Templates should include: "Only report activities you can verify from the recordings. If uncertain, say so."
- **Formatting consistency:** Define expected output format per template (markdown sections, tables, bullet points) so results feel polished.

### Custom Summary Builder
- **Filter combinatorics:** User selects "Last Week" + "Chrome" + "Audio only" — the intersection might be empty. Show live count to set expectations.
- **App/website list loading:** Must query distinct apps from DB. Existing `/search` doesn't expose this — may need new endpoint or cache from `suggestions.rs` activity detection.
- **"Save as Template" persistence:** Where to store? Options: (a) localStorage — simplest, lost on reinstall, (b) screenpipe DB — survives reinstalls, (c) as a Pipe — enables scheduling.

### Pipes Integration
- Louis noted: "I think it would go well with the pipes, which is basically scheduled prompt, so you could easily end a good chat and then wanting to have this kind of summary on schedule"
- **"Save as Template" → Create Pipe:** User's custom summary config (filters + prompt) could be exported as a `pipe.md` with a schedule. E.g., "Day Recap at 6 PM every weekday."
- **Existing Daily Summary overlap:** `daily-summary.tsx` already generates a summary at 6 PM. This feature supersedes it — more flexible, more templates, user-configurable. Could deprecate the hardcoded daily summary.

### UI/UX
- **Mobile/small screens:** The builder modal is complex (two panels). On narrow windows, stack vertically or collapse filters into a sheet.
- **Accessibility:** Cards need keyboard navigation, ARIA labels, focus management in modal.
- **Dark mode:** Menelaus' screenshots show a dark UI — ensure all components respect the existing theme system.
- **Animation:** Cards should have subtle hover states. Modal should animate in. Loading state during generation should feel polished (current grid-dissolve animation could work).

### Privacy
- **Sensitive content in summaries:** User might generate a "Day Recap" that includes passwords, personal messages, medical info visible on screen. Consider: (a) PII filtering option, (b) warning on first use, (c) summaries stored in chat history only (not exported).
- **Shared screens:** If someone is screen-sharing when generating a summary, the results could expose private data. No mitigation needed beyond user awareness.

---

## Integration with Existing System

### What to Reuse
| Existing | Use For |
|----------|---------|
| `suggestions.rs` auto-suggestions | Activity detection for context-aware featured cards |
| PI agent (`pi.rs`) | Executing summary prompts — no new AI backend needed |
| `/search` API | Querying memories with time/app/content filters |
| `standalone-chat.tsx` empty state | Mounting point for pre-chat landing page |
| `daily-summary.tsx` JSON schema | Output format reference for Day Recap |
| Chat message rendering | Displaying summary results (markdown, tables, etc.) |

### What to Build New
| Component | Location |
|-----------|----------|
| Pre-chat landing cards | `components/chat/summary-cards.tsx` |
| Library modal | `components/chat/summary-library.tsx` |
| Custom builder modal | `components/chat/custom-summary-builder.tsx` |
| Template definitions | `lib/summary-templates.ts` (JSON config) |
| Memory count API | Server-side: fast count query; or client-side: cached search with limit=0 |
| "Save as Template" | localStorage + optional pipe export |

### What to Modify
| File | Change |
|------|--------|
| `standalone-chat.tsx` | Replace empty-state auto-suggestion chips with summary cards |
| Search API (optional) | Add `count_only` parameter for lightweight counts |
| `suggestions.rs` (optional) | Expose detected activity mode to frontend for context-aware card ordering |

---

## Success Metrics

- **Engagement:** % of sessions where user clicks a summary card (vs. typing manually or leaving)
- **Completion:** % of summary generations that complete (vs. error/timeout)
- **Repeat usage:** How often users return to the same template
- **Custom templates saved:** Indicator of power-user adoption
- **Time-to-first-value:** Time from app open to first AI-generated insight (target: <5 seconds for one-click)

---

## Phased Rollout

### Phase 1: Pre-Chat Cards (MVP)
- Replace empty chat state with 5 featured summary cards + Discover
- Templates are hardcoded prompts sent to PI agent
- No custom builder, no library modal yet
- Ship fast, measure engagement

### Phase 2: Library + Custom Builder
- Add "Discover" modal with all 10 templates
- Add Custom Summary builder with time/app/website filters
- Memory count queries
- "Save as Template" to localStorage

### Phase 3: Pipes Integration
- "Save as Pipe" exports summary config as scheduled pipe
- Pipe results appear in chat or notification
- Deprecate hardcoded daily summary in favor of user-configured Day Recap pipe

---

## Open Questions

1. **Template maintenance:** Who curates the prompt library? Should users be able to submit templates (community library)?
2. **Model dependency:** Templates assume PI agent (Claude). Do they work with other models? Should prompts be model-agnostic?
3. **Localization:** Templates are English-only. Should the prompt library support i18n?
4. **Offline:** If no internet (local model), do summaries still work? PI agent requires connectivity for cloud models.
5. **Quota:** Each summary consumes AI tokens. Should there be a daily limit or does existing quota system handle this?
