// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ listeners: new Set<(event: any) => void>() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async (_topic: string, listener: (event: any) => void) => { mocks.listeners.add(listener); return () => mocks.listeners.delete(listener); } }));
import { usePrivateModelVerification } from "./private-model-verification";
afterEach(() => { cleanup(); mocks.listeners.clear(); });
function PrivateModelVerification(props: Parameters<typeof usePrivateModelVerification>[0] & { open?: boolean }) {
  const verification = usePrivateModelVerification(props);
  return props.open === false ? null : verification;
}
const preset = { provider: "screenpipe-cloud", model: "glm-5.3-flash-reap50-iq3m" };
it("only shows confidential Screenpipe models and scopes evidence to the active Pi session", () => {
  const view = render(<PrivateModelVerification sessionId="a" preset={preset} />);
  const emit = (sessionId: string, source = "pi") => act(() => mocks.listeners.forEach(listener => listener({ payload: { sessionId, source, event: { type: "extension_ui_request", method: "setStatus", key: "screenpipe-confidential", text: JSON.stringify({requestId: "r", state: "verifying"}) } } })));
  emit("b"); emit("a", "pipe");
  expect(screen.getByRole("button", { name: "Private AI: Not verified yet" })).toBeTruthy();
  view.rerender(<PrivateModelVerification sessionId="a" preset={preset} open={false} />);
  emit("a");
  view.rerender(<PrivateModelVerification sessionId="a" preset={preset} />);
  expect(screen.getByRole("button", { name: "Private AI: Verifying enclave…" })).toBeTruthy();
  view.rerender(<PrivateModelVerification sessionId="b" preset={preset} />);
  expect(screen.getByRole("button", { name: "Private AI: Not verified yet" })).toBeTruthy();
  view.rerender(<PrivateModelVerification sessionId="b" preset={{...preset, model:"auto"}} />);
  expect(screen.queryByRole("button")).toBeNull();
});
