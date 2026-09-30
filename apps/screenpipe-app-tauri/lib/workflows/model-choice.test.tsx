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
  await waitFor(() => expect(screen.getByRole("button", { name: "Workflows AI" })).toHaveTextContent("Private (Beta)"));
  expect(screen.queryByRole("button", { name: /Private AI:/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Workflows AI" }));
  expect(screen.getAllByRole("menuitemradio")).toHaveLength(2);
  expect(screen.getByRole("menuitem", { name: "Private AI: Not verified yet" })).toBeVisible();
  fireEvent.click(screen.getByRole("menuitemradio", { name: /Intelligent/ }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Workflows AI" })).toHaveTextContent("Intelligent"));
  first.unmount(); render(<WorkflowModelControl preference={preference} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Workflows AI" })).toHaveTextContent("Intelligent"));
});
it("does not display Private when persistence fails", async () => {
  render(<WorkflowModelControl preference={{ load: async () => "intelligent", save: async () => { throw Error("disk full"); } }} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Workflows AI" })).toHaveTextContent("Intelligent"));
  fireEvent.click(screen.getByRole("button", { name: "Workflows AI" }));
  fireEvent.click(screen.getByRole("menuitemradio", { name: /Private/ }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not save");
  expect(screen.getByRole("button", { name: "Workflows AI" })).toHaveTextContent("Intelligent");
});
it("fails closed on corrupt saved choices instead of switching Private to Intelligent", () => {
  expect(parseWorkflowModel(null)).toBe("intelligent");
  expect(parseWorkflowModel('{"mode":"private"}')).toBe("private");
  for (const text of ["{", "null", '{"mode":"gpt"}']) expect(() => parseWorkflowModel(text)).toThrow();
});

it("supports keyboard selection and closes the dropdown with Escape", async () => {
  render(<WorkflowModelControl preference={{ load: async () => "private", save: async () => {} }} />);
  const trigger = screen.getByRole("button", { name: "Workflows AI" });
  await waitFor(() => expect(trigger).toHaveTextContent("Private"));
  fireEvent.keyDown(trigger, { key: "ArrowDown" });
  const privateChoice = screen.getByRole("menuitemradio", { name: /Private/ });
  expect(privateChoice).toHaveFocus();
  fireEvent.keyDown(privateChoice, { key: "Home" });
  expect(screen.getByRole("menuitemradio", { name: /Intelligent/ })).toHaveFocus();
  fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });
  expect(screen.queryByRole("menu")).toBeNull();
  expect(trigger).toHaveFocus();
});
it("opens verification from inside the dropdown", async () => {
  const showModal = vi.fn();
  Object.defineProperty(HTMLDialogElement.prototype, "showModal", { configurable: true, value: showModal });
  render(<WorkflowModelControl preference={{ load: async () => "private", save: async () => {} }} />);
  await waitFor(() => expect(screen.getByRole("button", { name: "Workflows AI" })).toHaveTextContent("Private"));
  fireEvent.click(screen.getByRole("button", { name: "Workflows AI" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Private AI: Not verified yet" }));
  expect(showModal).toHaveBeenCalledTimes(1);
});
