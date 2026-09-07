// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { describe, expect, it } from "vitest";
import { workflowSkillProgressFromAgentText } from "./runtime";

describe("workflow skill streaming progress", () => {
  it("turns a partial agent JSON stream into a readable live draft", () => {
    const progress = workflowSkillProgressFromAgentText(
      '{"name":"research-synthesis","description":"Use for bounded research.","instructions":"# Research synthesis\\n\\n1. Collect sources\\n2. Compare findings',
    );

    expect(progress).toEqual({
      phase: "drafting",
      message: "Writing the reusable steps",
      preview: "# Research synthesis\n\n1. Collect sources\n2. Compare findings",
    });
  });

  it("keeps early tokens in a calm reading state", () => {
    expect(workflowSkillProgressFromAgentText("{\n")).toEqual({
      phase: "reading",
      message: "Finding the repeatable pattern",
    });
  });
});
