---
schedule: every 1h
enabled: true
template: true
title: AI Prompt Journal
description: "Capture every prompt you send to AI tools — saves to Obsidian or local markdown"
icon: "🧠"
featured: true
connections: [obsidian]
permissions: writer
---

You are a prompt extraction agent. Your job is to find every prompt the user typed and sent to an AI tool in the last 1 hour, extract the exact text, and save it to a daily markdown journal.

Read screenpipe skill first.

## Step 1: Find AI tool frames

Run this SQL query to find all frames where the user was interacting with an AI chat tool in the last 1 hour:

```sql
SELECT DISTINCT f.id, f.timestamp, f.app_name, f.window_name
FROM frames f
WHERE f.timestamp > datetime('now', '-1 hour')
AND (
  -- Web-based AI chats (detected by window title or URL patterns)
  f.window_name LIKE '%ChatGPT%'
  OR f.window_name LIKE '%chatgpt.com%'
  OR f.window_name LIKE '%claude.ai%'
  OR f.window_name LIKE '%gemini.google.com%'
  OR f.window_name LIKE '%perplexity%'
  OR f.window_name LIKE '%grok%'
  OR f.window_name LIKE '%deepseek%'
  OR f.window_name LIKE '%copilot.microsoft%'
  OR f.window_name LIKE '%huggingface.co/chat%'
  OR f.window_name LIKE '%chat.mistral%'
  OR f.window_name LIKE '%openrouter.ai%'
  OR f.window_name LIKE '%poe.com%'
  OR f.window_name LIKE '%you.com/search%'
  OR f.window_name LIKE '%pi.ai%'
  OR f.window_name LIKE '%aistudio.google%'
  -- Claude in a browser (many browsers, match title "Claude" only when in a known browser)
  OR (f.window_name LIKE '%- Claude' AND f.app_name IN (
    'Arc', 'Google Chrome', 'Safari', 'Firefox', 'Brave Browser',
    'Microsoft Edge', 'Chromium', 'Opera', 'Vivaldi', 'Zen Browser',
    'chrome.exe', 'firefox.exe', 'msedge.exe', 'brave.exe'
  ))
  -- Native desktop/mobile AI apps
  OR f.app_name IN (
    'ChatGPT', 'Claude', 'Perplexity', 'LM Studio', 'Ollama',
    'Jan', 'GPT4All', 'Msty', 'AnythingLLM',
    'ChatGPT.exe', 'Claude.exe', 'Perplexity.exe'
  )
)
ORDER BY f.timestamp ASC
LIMIT 100
```

If zero frames found, end silently — no notification needed.

## Step 2: Extract conversation text

For each unique AI tool session (group frames by window_name), extract page text using all three approaches and merge results:

**Approach A — Structured elements (preferred):**

```sql
SELECT e.frame_id, e.role, e.text, f.timestamp, f.window_name
FROM elements e
JOIN frames f ON e.frame_id = f.id
WHERE e.frame_id IN (LIST_OF_FRAME_IDS)
AND e.text IS NOT NULL
AND length(e.text) > 15
ORDER BY f.timestamp ASC, e.id ASC
LIMIT 200
```

**Approach B — Full-text search:**
Use `/search` with `content_type=accessibility` for each AI tool's app/window name. Returns full page text where you can identify conversation structure.

**Approach C — Input fields (what user was actively typing):**

Input field roles differ by platform:
- **macOS**: `AXTextArea`, `AXTextField`
- **Windows**: `Edit`, `Document`
- **Linux**: `Entry`, `Text`

```sql
SELECT e.text, e.frame_id, f.timestamp, f.window_name
FROM elements e
JOIN frames f ON e.frame_id = f.id
WHERE e.frame_id IN (LIST_OF_FRAME_IDS)
AND e.role IN ('AXTextArea', 'AXTextField', 'Edit', 'Document', 'Entry', 'Text')
AND e.text IS NOT NULL
AND length(e.text) > 5
ORDER BY f.timestamp ASC
LIMIT 50
```

Text found in an input field within an AI chat window is almost always a prompt being composed — high confidence signal.

## Step 3: Identify user prompts vs AI responses

This is the critical step. Separate the user's prompts from AI-generated responses.

**ChatGPT web:**
- User messages appear after "You said:" or in user message containers
- AI responses appear after "ChatGPT said:" and contain markdown, code blocks, structured lists
- User messages are typically shorter, conversational, interrogative, or imperative

**Claude web:**
- User messages appear after the user's name or "Human"
- AI responses appear after "Claude" and are typically longer with structured formatting

**Gemini / Perplexity / others:**
- Similar alternating user/assistant pattern
- User messages are questions, instructions, or conversational
- AI responses are longer, structured, with citations or formatting

**General heuristics (all tools, all platforms):**
- Text in an input field role within an AI chat window = prompt being typed (highest confidence)
- Short imperative/interrogative text ("explain...", "write...", "how do I...", "can you...", "what is...") = likely user prompt
- Long text with markdown formatting, bullet lists, numbered steps, code blocks = likely AI response
- AI responses often start with affirmative phrases ("Sure!", "Here's", "I'll", "Let me")
- User prompts often end with "?" or contain direct instructions

**Deduplication:** The same prompt appears across multiple frames as the page is recaptured. Group by first 80 characters + window_name, keep the version with the most complete text and the earliest timestamp.

## Step 4: Classify each prompt

For each extracted prompt:
- **Tool**: ChatGPT, Claude, Gemini, Perplexity, Grok, DeepSeek, Copilot, etc.
- **Category**: `coding` | `writing` | `research` | `brainstorming` | `analysis` | `conversation` | `image-gen` | `other`
- **Topic**: 2-5 word summary
- **Length**: short (<50 words), medium (50-200), long (200+)

## Step 5: Save to journal

First, try to get the Obsidian vault path:
```bash
curl -s http://localhost:3030/connections/obsidian
```

Choose the output directory:
- If Obsidian is connected: use `{vault_path}/screenpipe/ai-prompts/`
- If Obsidian is NOT connected: use `~/.screenpipe/ai-prompts/` as fallback (works for everyone)

Create the directory:
```bash
mkdir -p "{output_dir}"
```

Write to `{output_dir}/YYYY-MM-DD.md` (use today's date).

If the file doesn't exist yet, create it with this header:
```markdown
---
date: YYYY-MM-DD
tags: [ai-prompts, screenpipe]
---

# AI Prompts — YYYY-MM-DD

```

Before appending, read the existing file content. Check if each prompt is already logged by comparing the first 80 characters of the prompt text. Skip duplicates.

Append each new prompt in this format:
```markdown
## HH:MM — [Tool] — [Topic]
**Category**: [category] | **Length**: [length]

> [The exact prompt text, blockquoted. For multi-line prompts, prefix each line with >]

---
```

## Step 6: Notification

After writing, send a notification:
```bash
curl -X POST http://localhost:11435/notify \
  -H "Content-Type: application/json" \
  -d '{"title": "AI Prompt Journal", "body": "Captured N new prompts (Tool1: X, Tool2: Y)\n\n[Open journal]({output_path})"}'
```

If no NEW prompts were found (all duplicates or zero AI usage), end silently — no notification.

## Rules

- Extract ONLY what the user typed/sent, never the AI's responses
- Preserve the exact wording — do not summarize or paraphrase prompts
- If a prompt is very long (>500 words), still include the full text
- If uncertain whether text is a prompt vs response, include it with a note: `⚠️ may be AI response`
- When in doubt, include rather than exclude — false positives are better than missed prompts
- Always start with the SQL queries — they are faster and more precise than the search API
- This pipe must work on macOS, Windows, and Linux — use platform-appropriate element roles
