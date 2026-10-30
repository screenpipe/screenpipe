---
name: screenpipe-chats
description: Search what was said in existing screenpipe, Codex, Claude, Cursor, and Gemini CLI chats, then continue or steer one exact chat when the user explicitly asks. Use for requests about finding another agent conversation, recalling what an agent said, or sending work to one.
---

# existing agent chats

screenpipe exposes `search_chats` and `send_to_chat` as agent tools. They use a
private core capability passed into the current chat process; do not scrape
transcript folders, guess runtime commands, or call a localhost app route.

## search

1. Call `search_chats` with a short title, message, workspace, or exact id. The
   query also matches the transcript, so a phrase said mid-conversation finds
   the chat even when the title never mentions it. Omit the query to list recent
   chats. Filter `sources` only when the user named a runtime.
2. Show enough title, source, preview, and workspace information to distinguish
   ambiguous results.
3. Treat the returned `source` and `id` as the address. Never derive an id from
   a title or reuse a stale result after the target disappears.
4. Read the `warnings` array. Transcript reading is bounded to the most recent
   chats per runtime, so report that older chats were not searched instead of
   claiming a phrase was never said.

Searching is read-only and does not require confirmation.

## send

1. Require an exact result from `search_chats` in the current turn.
2. Require explicit user authorization for that target and message. A draft,
   suggestion, or request to inspect chats is not permission to send.
3. Call `send_to_chat` with the exact `source`, `id`, message, and
   `confirmed: true`.
4. Use `mode: queue` by default. Use `mode: steer` only when the user asked to
   redirect a currently running screenpipe chat.
5. Report the returned status and exact target. Do not retry an uncertain or
   failed send until the result is reconciled.

Gemini CLI chats are search-only: Gemini has no non-interactive resume, so
`send_to_chat` rejects them instead of opening an interactive session. Say so
and offer to summarize what the chat already contains.

The tool refuses self-sends, guessed ids, dormant-chat steering, oversized
messages, unsendable sources, and sends without confirmation. Cross-chat sending
is disabled in unattended scheduled runs.
