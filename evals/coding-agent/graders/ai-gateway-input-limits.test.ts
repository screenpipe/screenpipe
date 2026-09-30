// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { describe, expect, it } from "bun:test";
import {
  boundedModelChain,
  clientPayloadMessage,
  isTransient,
  isUserInputTooLarge,
  selectCascadeError,
} from "../handlers/chat";

const configuredLimit =
  "Input tokens exceed the configured limit of 100 tokens. Your messages resulted in 101 tokens.";
const availableContext =
  "request (201 tokens) exceeds the available context size (200 tokens), try increasing it";
const toolCallLimit =
  "Invalid 'messages[0].tool_calls': array too long. Expected an array with maximum length 2, but got an array with length 3 instead.";

describe("gateway input error outcomes", () => {
  it("recognizes configured input limits on supported client statuses", () => {
    for (const status of [400, 413]) {
      expect(isUserInputTooLarge(status, configuredLimit)).toBe(true);
      expect(isUserInputTooLarge(status, configuredLimit.toUpperCase())).toBe(true);
    }
  });

  it("recognizes an exceeded available context size", () => {
    expect(isUserInputTooLarge(400, availableContext)).toBe(true);
  });

  it("gives an actionable client message for excess tool calls", () => {
    for (const status of [400, 422]) {
      const message = clientPayloadMessage(status, toolCallLimit);
      expect(message).toMatch(/too many tool calls/i);
      expect(message).toMatch(/compact|new chat/i);
      expect(message).not.toContain("messages[0]");
    }
  });

  it("preserves previously supported input-size errors", () => {
    for (const message of [
      "prompt is too long: 101 tokens > 100 maximum",
      "maximum context length exceeded",
      "The input (101 tokens) is longer than the model's context length (100 tokens).",
      "The input token count (101) exceeds the maximum number of tokens allowed (100).",
    ]) expect(isUserInputTooLarge(400, message)).toBe(true);
  });

  it("does not relabel unrelated errors or unsupported status boundaries", () => {
    expect(isUserInputTooLarge(400, "invalid tool schema")).toBe(false);
    expect(isUserInputTooLarge(400, "")).toBe(false);
    for (const status of [0, 200, 401, 403, 429, 500]) {
      expect(isUserInputTooLarge(status, configuredLimit)).toBe(false);
      expect(isUserInputTooLarge(status, availableContext)).toBe(false);
      expect(clientPayloadMessage(status, toolCallLimit)).toBeNull();
    }
  });

  it("keeps near-neighbor non-tool arrays and thin errors unclassified", () => {
    for (const message of [
      toolCallLimit.replace("tool_calls", "attachments"),
      "tool_calls: invalid schema",
      "array too long",
      "",
    ]) expect(clientPayloadMessage(400, message)).toBeNull();
  });

  it("preserves image and empty-message guidance", () => {
    expect(clientPayloadMessage(400, "Failed to decode image data.")).toMatch(/image/i);
    expect(clientPayloadMessage(400, "at least one message is required")).toMatch(/message/i);
    expect(clientPayloadMessage(400, "invalid tool schema")).toBeNull();
  });

  it("preserves ordinary transient failures and non-transient client errors", () => {
    for (const status of [403, 404, 408, 429, 500, 503, 599]) {
      expect(isTransient(status, "upstream unavailable")).toBe(true);
    }
    expect(isTransient(400, "bad request")).toBe(false);
    expect(isTransient(401, "unauthorized")).toBe(false);
  });

  it("preserves terminal safety outcomes over earlier capacity advisories", () => {
    const capacity = Object.assign(new Error("provider capacity"), { userMessage: "try later" });
    const terminal = Object.assign(new Error("request declined"), { code: "safety_refusal" });
    expect(selectCascadeError(capacity, terminal)).toBe(terminal);
  });

  it("keeps model attempts bounded and ordered", () => {
    expect(boundedModelChain(["first-model", "second-model", "third-model"], 2))
      .toEqual(["first-model", "second-model"]);
  });
});
