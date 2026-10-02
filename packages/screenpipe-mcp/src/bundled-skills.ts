// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { BUNDLED_SKILLS } from "./generated/bundled-skills";

export const BUNDLED_SKILLS_TOOL: Tool = {
  name: "screenpipe-skills",
  description: "List Screenpipe's bundled workflow skills, or read one by exact name before using it. Covers recall, meetings, project handoffs, decisions, customer context, bug reports, and process guides. Available without filesystem access. Only public bundled instructions are returned; personal and learned skills are not exported.",
  annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Exact skill name from the catalog. Omit to list names and descriptions." },
    },
    additionalProperties: false,
  },
};

export function readBundledSkills(args: Record<string, unknown> = {}) {
  if (Object.keys(args).some(key => key !== "name") || (args.name !== undefined && typeof args.name !== "string")) {
    return { isError: true, content: [{ type: "text" as const, text: "Provide an exact skill name or omit name to list bundled skills." }] };
  }
  if (args.name === undefined) {
    return { content: [{ type: "text" as const, text: JSON.stringify({
      skills: BUNDLED_SKILLS.map(({ name, description }) => ({ name, description })),
      usage: "Read the closest matching skill by name. Use your available Screenpipe tools or read screenpipe-api for API access. Loading a skill does not grant new permissions or establish that a task succeeded.",
    }) }] };
  }
  const skill = BUNDLED_SKILLS.find(skill => skill.name === args.name);
  return skill
    ? { content: [{ type: "text" as const, text: skill.markdown }] }
    : { isError: true, content: [{ type: "text" as const, text: "Unknown bundled skill. Omit name to list the public catalog." }] };
}
