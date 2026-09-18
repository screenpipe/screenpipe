// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { WorkflowModelControl, parseWorkflowModel } from "@screenpipe/workflows-ui";
afterEach(cleanup);
it("offers exactly Intelligent and Private (Beta) and restores the saved selection", async () => {
  let mode: "intelligent" | "private" = "private";
  const preference = { load: async () => mode, save: vi.fn(async (next: typeof mode) => { mode = next; }) };
  const first = render(<WorkflowModelControl preference={preference} />);
  await waitFor(() => expect(screen.getByLabelText("Workflows AI")).toHaveValue("private"));
  expect(screen.getAllByRole("option").map(option => option.textContent)).toEqual(["Intelligent", "Private (Beta)"]);
  fireEvent.change(screen.getByLabelText("Workflows AI"), { target: { value: "intelligent" } });
  await waitFor(() => expect(screen.getByLabelText("Workflows AI")).toHaveValue("intelligent"));
  first.unmount(); render(<WorkflowModelControl preference={preference} />);
  await waitFor(() => expect(screen.getByLabelText("Workflows AI")).toHaveValue("intelligent"));
});
it("does not display Private when persistence fails", async () => {
  render(<WorkflowModelControl preference={{ load: async () => "intelligent", save: async () => { throw Error("disk full"); } }} />);
  await waitFor(() => expect(screen.getByLabelText("Workflows AI")).toHaveValue("intelligent"));
  fireEvent.change(screen.getByLabelText("Workflows AI"), { target: { value: "private" } });
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not save");
  expect(screen.getByLabelText("Workflows AI")).toHaveValue("intelligent");
});
it("fails closed on corrupt saved choices instead of switching Private to Intelligent", () => {
  expect(parseWorkflowModel(null)).toBe("intelligent");
  expect(parseWorkflowModel('{"mode":"private"}')).toBe("private");
  for (const text of ["{", "null", '{"mode":"gpt"}']) expect(() => parseWorkflowModel(text)).toThrow();
});
