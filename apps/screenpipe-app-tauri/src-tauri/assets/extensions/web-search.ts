import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "web_search",
    label: "Web Search",
    description:
      "Search the internet using Google Search. Use when the user asks about current events, people, companies, news, documentation, facts, or anything requiring up-to-date information from the web. Returns search results with sources.",
    parameters: Type.Object({
      query: Type.String({ description: "The search query" }),
    }),

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
