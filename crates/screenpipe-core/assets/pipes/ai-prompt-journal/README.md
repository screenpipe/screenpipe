# AI Prompt Journal

**Every prompt you send to AI — automatically captured and organized in your vault.**

You use ChatGPT, Claude, Gemini, Perplexity, and a dozen other AI tools every day. But what did you actually *ask* them? What problems were you solving? What ideas were you exploring?

AI Prompt Journal watches your screen and captures every prompt you type into AI tools — then saves them as a clean, searchable daily journal in your Obsidian vault (or local markdown).

## What it does

- **Monitors 15+ AI tools** — ChatGPT, Claude, Gemini, Perplexity, Grok, DeepSeek, Copilot, Mistral, Poe, HuggingChat, OpenRouter, LM Studio, Ollama, Jan, GPT4All, and more
- **Extracts only YOUR prompts** — smart heuristics separate what you typed from AI responses
- **Auto-classifies** each prompt by tool, category (coding, writing, research, brainstorming...), topic, and length
- **Saves to Obsidian** — daily notes with YAML frontmatter and tags, ready for search and backlinks
- **Falls back gracefully** — no Obsidian? Saves to `~/.screenpipe/ai-prompts/` as plain markdown
- **Deduplicates** — won't log the same prompt twice even if the page is captured multiple times
- **Cross-platform** — works on macOS, Windows, and Linux

## Example output

```markdown
## 09:15 — ChatGPT — React auth flow
**Category**: coding | **Length**: long

> How do I implement OAuth 2.0 with PKCE in a React SPA? I need to support
> Google and GitHub providers. Show me the full flow including token refresh.

---

## 10:42 — Claude — Quarterly planning
**Category**: writing | **Length**: medium

> Help me draft the Q3 roadmap for our team. We need to prioritize
> infrastructure work vs new features. Budget is flat.

---

## 11:30 — Perplexity — Market research
**Category**: research | **Length**: short

> What's the current market size for AI-powered CRM tools in 2026?

---
```

## Why this matters

- **Remember your best prompts** — that perfect prompt you crafted 3 weeks ago? Now you can find it
- **Track AI usage patterns** — see which tools you use for what, and how your usage evolves
- **Team visibility** — share the journal with your team to see what problems everyone is solving with AI
- **Prompt library** — over time, build a personal library of effective prompts organized by topic
- **Audit trail** — know exactly what data you fed into which AI tool, when

## Setup

1. Install this pipe from the screenpipe store
2. (Optional) Connect Obsidian in Settings > Connections — set your vault path
3. The pipe runs every hour automatically and captures any AI prompts from the last hour
4. Check your journal at `{vault}/screenpipe/ai-prompts/YYYY-MM-DD.md`

## How it works

The pipe uses screenpipe's accessibility tree and OCR data to read what's on your screen. It:

1. **Finds AI tool frames** — SQL query matches window titles and app names against known AI tools
2. **Extracts text** — pulls structured elements, full-page text, and input field contents
3. **Separates prompts from responses** — uses conversation structure, element roles, and text heuristics
4. **Deduplicates** — groups identical text across frames, keeps the most complete version
5. **Classifies and saves** — categorizes each prompt and appends to the daily journal

Everything runs locally. Your prompts never leave your machine.

## Supported AI tools

| Tool | Detection method |
|------|-----------------|
| ChatGPT | App name or window title |
| Claude | Browser window title pattern |
| Gemini | URL pattern |
| Perplexity | App name or URL |
| Grok | URL pattern |
| DeepSeek | URL pattern |
| Copilot | URL pattern |
| Mistral | URL pattern |
| Poe | URL pattern |
| HuggingChat | URL pattern |
| OpenRouter | URL pattern |
| Google AI Studio | URL pattern |
| LM Studio | Native app name |
| Ollama | Native app name |
| Jan | Native app name |
| GPT4All | Native app name |

## Privacy

- Runs 100% locally — no data sent anywhere
- Only reads screen data already captured by screenpipe
- Prompts are saved to your local filesystem only
- You control the output location (Obsidian vault or ~/.screenpipe/)
