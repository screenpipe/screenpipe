# Screenpipe Cloud

Search your synced screen content, audio transcriptions, app data, and memories
across Screenpipe devices. Requires a Screenpipe account with Data Sync available
and enabled. Only records already synced to that account are searchable.

This cloud connector provides `synced-devices` and `search-synced-content`.
It does not expose local-only recordings, desktop control, or enterprise team
records. Signing in does not enable Data Sync or start uploading recordings.

## ChatGPT

For a private developer connection, enable Developer mode if permitted by your
account/workspace, open [Plugins](https://chatgpt.com/plugins), select the plus
button, and connect this HTTPS MCP endpoint:

```text
https://screenpipe.com/api/user/data-sync/mcp
```

Complete Screenpipe's OAuth sign-in and review the tools. Use a new conversation
to ask which devices have synced recently. An empty device list does not mean
the connector can see local-only recordings.

The ZIP is a portable plugin package for local plugin hosts and private testing.
It is not a public ChatGPT listing. Public installation from the directory
requires a **With MCP** submission and platform review; submit the endpoint,
not a localhost URL or the Claude Desktop `.mcpb` file.

## Claude

In Claude's connector settings, add a custom remote connector with the same
HTTPS URL and complete OAuth sign-in. Availability depends on workspace policy.
The ZIP also includes `.claude-plugin/plugin.json` and `.mcp.json` for Claude
plugin hosts. For Claude Code local development, unzip it and run:

```sh
claude --plugin-dir /absolute/path/to/screenpipe-cloud
```

Use `/mcp` to finish authentication. No API token belongs in the archive.

For recordings that stay on your computer, use the separate
`screenpipe-local.mcpb` installer in Claude Desktop instead. Install it through
Settings → Extensions → Advanced settings → Install Extension, then select the
file. Keep Screenpipe running. Its optional local API key field is stored by
the host as a sensitive setting; if blank, the existing Screenpipe CLI discovery
path is used. Do not enable both local connection methods under the same server
name.

## Privacy and support

The cloud connector reads records already uploaded through Data Sync. Results
you request are sent to the connected AI provider. Its OAuth scope is
`data-sync:read`; it has no write tools. Disconnect it in your AI client's
settings when you no longer want access.

[Privacy](https://screenpipe.com/privacy) ·
[Terms](https://screenpipe.com/terms) ·
[Support](https://github.com/screenpipe/screenpipe/issues)

Packaging references:
[OpenAI](https://developers.openai.com/plugins/build/plugins),
[Claude plugins](https://code.claude.com/docs/en/plugins-reference),
[Claude Desktop bundles](https://github.com/anthropics/mcpb).
