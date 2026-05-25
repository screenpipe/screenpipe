import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Plain JSON-Schema literal — registerTool only stores it for the LLM,
// no runtime validation, so we don't need @sinclair/typebox here. The
// extension lives in <project>/.pi/extensions/ where typebox isn't
// resolvable from pi-agent/node_modules.
const params = {
  type: "object",
  properties: {
    query: { type: "string", description: "The search query" },
  },
  required: ["query"],
} as any;

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the internet using Google Search. Use when the user asks about current events, people, companies, news, documentation, facts, or anything requiring up-to-date information from the web. Returns search results with sources.",
    parameters: params,

    async execute(
      toolCallId: string,
      params: { query: string },
      signal: AbortSignal,
      onUpdate: any
    ) {
      if (signal?.aborted) {
        return { content: [{ type: "text" as const, text: "Cancelled" }] };
      }

      onUpdate?.({
        content: [
          {
            type: "text" as const,
            text: `Searching the web for "${params.query}"...`,
          },
        ],
      });

      const apiKey = process.env.SCREENPIPE_API_KEY || "";
      const response = await fetch(
        "https://api.screenpipe.com/v1/web-search",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({ query: params.query }),
          signal,
        }
      );

      if (!response.ok) {
        const errorText = await response.text().catch(() => "Unknown error");
        return {
          content: [
            {
              type: "text" as const,
              text: `Web search failed (${response.status}): ${errorText}`,
            },
          ],
        };
      }

      const data = (await response.json()) as {
        content: string;
        sources: Array<{ title?: string; url?: string }>;
      };

      return {
        content: [{ type: "text" as const, text: data.content }],
        details: { sources: data.sources, query: params.query },
      };
    },
  });
}
