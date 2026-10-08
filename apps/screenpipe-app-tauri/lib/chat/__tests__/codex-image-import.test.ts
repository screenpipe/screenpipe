// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { describe, expect, it } from "vitest";
import { normalizeImportedCodexConversation, parseCodexTranscript } from "../external-chat-parser";

const image = "data:image/png;base64,aGVsbG8=";
const tag = '<image name=[Image #1] path="/tmp/My screenshot.png">';
function parse(text: string, parts: unknown[] = []) {
  return parseCodexTranscript(JSON.stringify({ type: "response_item", payload: {
    type: "message", role: "user", content: [{ type: "input_text", text }, ...parts],
  } }), { sourceId: "images", fallbackTimestamp: 1 });
}

describe("Codex imported image attachments", () => {
  it("preserves embedded images and removes their transport tags", () => {
    const conversation = parse(`Explain this\n\n${tag}\n</image>`, [
      { type: "input_image", image_url: image },
    ]);
    expect(conversation?.messages[0]).toMatchObject({ content: "Explain this", images: [image] });
    expect(conversation?.title).toBe("Explain this");
  });

  it("retains image-only messages", () => {
    const conversation = parse("", [{ type: "input_image", image_url: image }]);
    expect(conversation?.messages).toHaveLength(1);
    expect(conversation?.messages[0].images).toEqual([image]);
  });

  it("renders path-only attachments through the existing local Markdown image loader", () => {
    const conversation = parse(`Explain this\n\n${tag}`);
    expect(conversation?.messages[0].content).toBe("Explain this\n\n![Image #1](</tmp/My%20screenshot.png>)");
    expect(conversation?.title).toBe("Explain this");
  });

  it("preserves quoted image markup and rejects remote image sources", () => {
    const text = `Explain this syntax:\n\n\`\`\`xml\n${tag}\n\`\`\``;
    expect(parse(text)?.messages[0].content).toBe(text);
    const remoteTag = '<image name=[Image #1] path="https://example.com/tracker.png">';
    expect(parse(remoteTag, [{ type: "input_image", image_url: "https://example.com/tracker.png" }])?.messages[0].content).toBe(remoteTag);
    expect(parse("hello", [{ type: "input_image", image_url: "data:text/html;base64,aGVsbG8=" }])?.messages[0].images).toBeUndefined();
  });

  it("keeps unmatched local references when some attachments have no embedded data", () => {
    const secondTag = '<image name=[Image #2] path="C:\\Screenshots\\two.png">';
    const conversation = parse(`Compare these\n${tag}\n${secondTag}`, [{ type: "input_image", image_url: image }]);
    expect(conversation?.messages[0].images).toEqual([image]);
    expect(conversation?.messages[0].content).toContain("![Image #2](<C:/Screenshots/two.png>)");
    expect(conversation?.messages[0].content).not.toContain("<image");
  });

  it("repairs cached imports on load without changing locally continued messages", () => {
    const conversation = parse("Explain this")!;
    conversation.messages[0].content = `Explain this\n\n${tag}`;
    conversation.messages.push({ ...conversation.messages[0], id: "local-turn", importedFrom: undefined });
    const repaired = normalizeImportedCodexConversation(conversation);
    expect(repaired.messages[0].content).toContain("![Image #1](</tmp/My%20screenshot.png>)");
    expect(repaired.messages[1].content).toContain(tag);
    expect(normalizeImportedCodexConversation(repaired)).toBe(repaired);
  });
});
