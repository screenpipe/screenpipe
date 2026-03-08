# Screenpipe MCP Server

<a href="https://www.pulsemcp.com/servers/screenpipe-screenpipe"><img src="https://www.pulsemcp.com/badge/top-pick/screenpipe-screenpipe" width="400" alt="PulseMCP Badge"></a>

<br/>

https://github.com/user-attachments/assets/7466a689-7703-4f0b-b3e1-b1cb9ed70cff

MCP server for screenpipe - search your screen recordings, audio transcriptions, and control your computer with AI.

## Installation

### Option 1: NPX (Recommended)

The easiest way to use screenpipe-mcp is with npx. Edit your Claude Desktop config:

- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%AppData%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "screenpipe": {
      "command": "npx",
      "args": ["-y", "screenpipe-mcp"]
    }
  }
}
```

### Option 2: HTTP Server (Remote / Network Access)

The MCP server can run over HTTP using the [Streamable HTTP transport](https://modelcontextprotocol.io/specification/2025-03-26/basic/transports#streamable-http), allowing remote MCP clients to connect over the network instead of stdio. This is ideal when your AI assistant (e.g., OpenClaw) runs on a different machine than screenpipe.

```bash
# from npm
npx screenpipe-mcp-http --port 3031

# or from source
npm run start:http -- --port 3031
```

The server exposes:
- **MCP endpoint**: `http://localhost:3031/mcp` — Streamable HTTP transport (POST for requests, GET for SSE stream)
- **Health check**: `http://localhost:3031/health`

**Options:**
| Flag | Description | Default |
|------|-------------|---------|
| `--port` | Port for the MCP HTTP server | 3031 |
| `--screenpipe-port` | Port where screenpipe API is running | 3030 |

**Connecting a remote MCP client:**

Point any MCP client that supports HTTP transport at the `/mcp` endpoint:

```json
{
  "mcpServers": {
    "screenpipe": {
      "url": "http://<your-ip>:3031/mcp"
    }
  }
}
```

If your machines are on different networks, expose port 3031 via Tailscale, SSH tunnel, or similar — see the [OpenClaw integration guide](https://docs.screenpi.pe/openclaw) for detailed examples.

> **Note:** The HTTP server currently exposes `search_content` only. The stdio server has the full tool set (export-video, list-meetings, activity-summary, search-elements, frame-context). We're working on bringing HTTP to full parity.

### Option 3: From Source

Clone and build from source:

```bash
git clone https://github.com/screenpipe/screenpipe
cd screenpipe/crates/screenpipe-integrations/screenpipe-mcp
npm install
npm run build
```

Then configure Claude Desktop:

```json
{
  "mcpServers": {
    "screenpipe": {
      "command": "node",
      "args": ["/absolute/path/to/screenpipe-mcp/dist/index.js"]
    }
  }
}
```

**Note:** Restart Claude Desktop after making changes.

## Testing

Test with MCP Inspector:

```bash
npx @modelcontextprotocol/inspector npx screenpipe-mcp
```

## Transport Modes

| Mode | Command | Use Case |
|------|---------|----------|
| **stdio** (default) | `npx screenpipe-mcp` | Claude Desktop, local MCP clients |
| **HTTP** | `npx screenpipe-mcp-http` | Remote clients, network access, OpenClaw on VPS |

## Available Tools

### search-content
Search through recorded content with content type filtering:
- `all` — OCR + Audio + Accessibility (default)
- `ocr` — Screen text from screenshots
- `audio` — Audio transcriptions
- `input` — User actions (clicks, keystrokes, clipboard, app switches)
- `accessibility` — Accessibility tree text
- Time range, app/window, and speaker filtering
- Pagination support

### export-video
Export screen recordings as video files:
- Specify time range with start/end times
- Configurable FPS for output video

### activity-summary
Get a lightweight compressed activity overview for a time range:
- App usage with active minutes and frame counts
- Recent accessibility texts
- Audio speaker summary

### list-meetings
List detected meetings with duration, app, and attendees.

### search-elements
Search structured UI elements (accessibility tree nodes and OCR text blocks):
- Filter by source, role, app, time range
- Much lighter than search-content for targeted UI lookups

### frame-context
Get accessibility text, parsed tree nodes, and extracted URLs for a specific frame.

## Example Queries in Claude

- "Search for any mentions of 'rust' in my screen recordings"
- "Find audio transcriptions from the last hour"
- "Show me what was on my screen in VSCode yesterday"
- "Export a video of my screen from 2-3pm today"
- "Find what John said in our meeting about the database"
- "What did I type in Slack today?" (uses content_type=input)
- "What did I copy to clipboard recently?" (uses content_type=input)
- "Show me accessibility text from Chrome" (uses content_type=accessibility)

## Requirements

- screenpipe must be running on localhost:3030
- Node.js >= 18.0.0

## Notes

- All timestamps are handled in UTC
- Results are formatted for readability in Claude's interface
- macOS automation features require accessibility permissions
