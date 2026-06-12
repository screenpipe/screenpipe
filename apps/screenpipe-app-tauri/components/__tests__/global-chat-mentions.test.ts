import { describe, it, expect } from "vitest";
import "../../vitest.setup";
import { buildAppMentionSuggestions, buildTagMentionSuggestions, parseMentions } from "../../lib/chat-utils";

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
    expect(mentions.tagNames).toEqual([]);
  });

  it("parses tag mentions using # syntax", () => {
    const mentions = parseMentions("#firefox @today summarize browsing", {
      appTagMap: {},
    });

    expect(mentions.tagNames).toEqual(["firefox"]);
    expect(mentions.timeRanges).toHaveLength(1);
    expect(mentions.cleanedInput).toBe("summarize browsing");
  });

  it("builds tag suggestions from tag counts", () => {
    const suggestions = buildTagMentionSuggestions(
      [
        { name: "firefox", count: 833, frame_count: 833 },
        { name: "coding", count: 140, frame_count: 138, memory_count: 2 },
      ],
      10,
    );

    expect(suggestions).toEqual([
      { tag: "#firefox", description: "833 frames", category: "tag" },
      { tag: "#coding", description: "138 frames, 2 memories", category: "tag" },
    ]);
  });

  it("builds tag suggestions from memory and audio counts", () => {
    const suggestions = buildTagMentionSuggestions(
      [
        { name: "person:louis", count: 3, memory_count: 3 },
        { name: "call", count: 2, audio_count: 2 },
      ],
      10,
    );

    expect(suggestions).toEqual([
      { tag: "#person:louis", description: "3 memories", category: "tag" },
      { tag: "#call", description: "2 audio clips", category: "tag" },
    ]);
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
