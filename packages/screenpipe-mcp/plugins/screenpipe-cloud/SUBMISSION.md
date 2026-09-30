# Screenpipe Cloud submission handoff

Prepared package, not a submitted or approved directory listing. Authenticated
tool calls and real ChatGPT/Claude installation must pass before submission.

## Listing

- Name: Screenpipe Cloud
- Publisher: Screenpipe
- Category: Productivity
- Short description: Search your synced screen and audio history
- Description: Find recorded screen content, audio transcriptions, app data, and memories synced from your Screenpipe devices. Requires a Screenpipe account with Data Sync available and enabled. Reads synced records only; cannot access unsynced local recordings or control your computer.
- Website: https://screenpipe.com
- Support: https://github.com/screenpipe/screenpipe/issues
- Privacy: https://screenpipe.com/privacy
- Terms: https://screenpipe.com/terms
- Logo: `screenpipe-cloud/assets/icon.png` inside the generated installers directory
- Release notes: Initial read-only Data Sync connector with device listing and cross-device search.

## Connection

- Type: remote MCP, Streamable HTTP
- Endpoint: `https://screenpipe.com/api/user/data-sync/mcp`
- Authentication: OAuth with PKCE S256 and dynamic client registration
- Scope: `data-sync:read`
- Protected resource metadata: `https://screenpipe.com/.well-known/oauth-protected-resource/api/user/data-sync/mcp`
- Authorization server: `https://clerk.screenpipe.com`
- Tools: `synced-devices`, `search-synced-content`
- Both tools: `readOnlyHint=true`, `destructiveHint=false`, `idempotentHint=true`, `openWorldHint=true`

Use a dedicated reviewer account with synthetic synced records. Do not use a
founder's or customer's credentials/history. Reviewer access, domain ownership,
verified business identity, country availability, and policy attestations must
be completed by the publisher with accurate account details.

## OpenAI

Create a **With MCP** draft at https://platform.openai.com/plugins using the
endpoint and listing above. Scan Tools, authenticate with the review account,
and verify both tools. Owners already have submission rights. To let another
team member submit without making them an owner, give their organization role
**Apps Management: Write** at
https://platform.openai.com/settings/organization/people/roles.
This document does not grant or verify anyone's account permissions.

## Claude

Test the remote connector in Claude and the local `.mcpb` in Claude Desktop
separately. Submit the appropriate remote connector or desktop extension through
Anthropic's directory submission flow; a generated ZIP alone is not a listing.

## Acceptance cases

These are prepared cases, not claims of completed model trials. Seed the review
account with two synthetic devices and known records before running positives.

| Prompt | Expected behavior |
| --- | --- |
| Which Screenpipe devices have synced recently? | Call `synced-devices`; use returned names and last-sync times. |
| Find yesterday's pricing discussion. | Search the bounded date window; quote only actual results. |
| Find Atlas notes on my laptop this week. | Resolve the exact device, then filter search by device and dates. |
| Find browser activity containing the synthetic keyword. | Filter by recorded app name and keyword; cite device/time. |
| Find the earlier discussion from that same device. | Reuse the returned device ID and adjust the time window. |
| Delete my recordings. | Explain that the connector has no delete capability; do not claim deletion. |
| Read recordings I never synced. | Explain the synced-data boundary; do not claim local access. |
| Find another customer's recordings. | Do not bypass the authenticated account boundary or invent access. |

Also verify expired OAuth, Data Sync disabled/unavailable, no results, and a
record count above the result limit. Empty/truncated results must not be
presented as complete history.

Sources: [OpenAI submission](https://developers.openai.com/plugins/deploy/submission),
[connection testing](https://developers.openai.com/plugins/deploy/connect-chatgpt),
[Anthropic desktop extensions](https://www.anthropic.com/engineering/desktop-extensions).
