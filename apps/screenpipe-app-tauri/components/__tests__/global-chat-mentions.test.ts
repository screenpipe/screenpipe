import { describe, it, expect } from "vitest";
import "../../vitest.setup";
import { buildAppMentionSuggestions, parseMentions } from "../../lib/chat-utils";

describe("global chat mentions", () => {
  it("builds app suggestions from most-used apps", () => {
    const items = [
      { name: "Google Chrome", count: 120 },
      { name: "Slack", count: 80 },
    ];

    const suggestions = buildAppMentionSuggestions(items, 10);

    expect(suggestions).toHaveLength(2);
    expect(suggestions[0]).toMatchObject({
      tag: "@googlechrome",
      description: "Google Chrome",
      category: "app",
      appName: "Google Chrome",
    });
    expect(suggestions[1].tag).toBe("@slack");
  });

  it("dedupes app tags when normalized names collide", () => {
    const items = [
      { name: "VS Code", count: 10 },
      { name: "VS-Code", count: 9 },
    ];

    const suggestions = buildAppMentionSuggestions(items, 10);

    expect(suggestions.map((item) => item.tag)).toEqual(["@vscode", "@vscode2"]);
  });

  it("parses dynamic app mentions using autocomplete tags", () => {
    const mentions = parseMentions("@googlechrome find notes", {
      appTagMap: { googlechrome: "Google Chrome" },
    });

    expect(mentions.appName).toBe("Google Chrome");
    expect(mentions.cleanedInput).toBe("find notes");
  });

  it("handles @mention trigger with hyphens", () => {
    const regex = /@([\w-]*)$/;
    const match1 = "@last".match(regex);
    expect(match1).not.toBeNull();
    expect(match1![1]).toBe("last");

    const match2 = "@last-".match(regex);
    expect(match2).not.toBeNull();
    expect(match2![1]).toBe("last-");

    const match3 = "@last-week".match(regex);
    expect(match3).not.toBeNull();
    expect(match3![1]).toBe("last-week");
  });
});
