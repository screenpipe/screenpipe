// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, it } from "vitest";
import { useSidebarWidth } from "@/lib/hooks/use-sidebar-width";
import { useNavigationWidth } from "../../node_modules/@screenpipe/workflows-ui/src/use-navigation-width";

function WorkspacePair() {
  const memory = useSidebarWidth();
  const workflows = useNavigationWidth(true, false, "screenpipe:sidebar-width");
  return <>
    <output data-testid="memory-width">{memory.width}</output>
    <div data-testid="memory-resize" onPointerDown={memory.beginResize} />
    <div {...workflows.separatorProps} />
  </>;
}
beforeEach(() => localStorage.clear());
it("preserves Memory's saved width and updates both mounted modes after resizing either one", () => {
  localStorage.setItem("screenpipe:sidebar-width", "304");
  localStorage.setItem("workflows:navigation-width", "240");
  render(<WorkspacePair />);
  const workflows = screen.getByRole("separator");
  expect(workflows).toHaveAttribute("aria-valuenow", "304");
  fireEvent.keyDown(workflows, { key: "ArrowRight" });
  expect(screen.getByTestId("memory-width")).toHaveTextContent("312");
  expect(localStorage.getItem("screenpipe:sidebar-width")).toBe("312");
  fireEvent(screen.getByTestId("memory-resize"), new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 312 }));
  fireEvent(window, new MouseEvent("pointerup", { clientX: 344 }));
  expect(workflows).toHaveAttribute("aria-valuenow", "344");
  expect(localStorage.getItem("workflows:navigation-width")).toBe("240");
});
it("syncs a width changed by another window", () => {
  render(<WorkspacePair />);
  act(() => {
    localStorage.setItem("screenpipe:sidebar-width", "288");
    window.dispatchEvent(new StorageEvent("storage", { key: "screenpipe:sidebar-width", newValue: "288" }));
  });
  expect(screen.getByTestId("memory-width")).toHaveTextContent("288");
  expect(screen.getByRole("separator")).toHaveAttribute("aria-valuenow", "288");
});
it("keeps standalone Workflows width independent of the desktop preference", () => {
  localStorage.setItem("screenpipe:sidebar-width", "304");
  localStorage.setItem("workflows:navigation-width", "264");
  function Standalone() { const nav = useNavigationWidth(true, false); return <div {...nav.separatorProps} />; }
  render(<Standalone />);
  const separator = screen.getByRole("separator");
  expect(separator).toHaveAttribute("aria-valuenow", "264");
  fireEvent.keyDown(separator, { key: "ArrowRight" });
  expect(localStorage.getItem("workflows:navigation-width")).toBe("272");
  expect(localStorage.getItem("screenpipe:sidebar-width")).toBe("304");
});
