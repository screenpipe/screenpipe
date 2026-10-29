// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WorkflowModelControl, parseWorkflowModel } from "@screenpipe/workflows-ui";
afterEach(cleanup);
it("removes Private from choices and requires an explicit replacement for saved Private", async () => {
  let mode: "intelligent" | "private" = "private";
  const preference = { load: async () => mode, save: vi.fn(async (next: typeof mode) => { mode = next; }) };
  render(<WorkflowModelControl preference={preference} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Workflows AI" })).toHaveTextContent("Private (retired)"));
  expect(preference.save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Workflows AI" }));
  expect(screen.getAllByRole("menuitemradio")).toHaveLength(1);
  expect(screen.queryByRole("menuitemradio", { name: /Private/ })).toBeNull();
  expect(screen.getByRole("alert")).toHaveTextContent("no longer available");
  fireEvent.click(screen.getByRole("menuitemradio", { name: /Intelligent/ }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Workflows AI" })).toHaveTextContent("Intelligent"));
  expect(preference.save).toHaveBeenCalledWith("intelligent");
});
it("preserves saved Private and reports a failed replacement", async () => {
  render(<WorkflowModelControl preference={{ load: async () => "private", save: async () => { throw Error("disk full"); } }} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Workflows AI" })).toHaveTextContent("Private (retired)"));
  fireEvent.click(screen.getByRole("button", { name: "Workflows AI" }));
  fireEvent.click(screen.getByRole("menuitemradio", { name: /Intelligent/ }));
  await waitFor(() => expect(screen.getAllByRole("alert").some(node => node.textContent?.includes("Could not save"))).toBe(true));
  expect(screen.getByRole("button", { name: "Workflows AI" })).toHaveTextContent("Private (retired)");
});
it("reads legacy Private without silently replacing it and rejects corrupt choices", () => {
  expect(parseWorkflowModel(null)).toBe("intelligent");
  expect(parseWorkflowModel('{"mode":"private"}')).toBe("private");
  for (const text of ["{", "null", '{"mode":"gpt"}']) expect(() => parseWorkflowModel(text)).toThrow();
});
it("keeps the remaining model keyboard accessible", async () => {
  render(<WorkflowModelControl preference={{ load: async () => "private", save: async () => {} }} />);
  const trigger=screen.getByRole("button",{name:"Workflows AI"});
  await waitFor(() => expect(trigger).toHaveTextContent("Private (retired)"));
  fireEvent.keyDown(trigger,{key:"ArrowDown"});
  expect(screen.getByRole("menuitemradio",{name:/Intelligent/})).toHaveFocus();
  fireEvent.keyDown(screen.getByRole("menu"),{key:"Escape"});
  expect(screen.queryByRole("menu")).toBeNull();expect(trigger).toHaveFocus();
});
