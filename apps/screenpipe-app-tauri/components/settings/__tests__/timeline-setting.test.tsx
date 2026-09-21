// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { render } from "@/lib/i18n/test-utils";
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>, managed: {} as Record<string, string>,
  updateSettings: vi.fn(), toast: vi.fn(), stop: vi.fn(), spawn: vi.fn(),
  showReminder: vi.fn(), hideReminder: vi.fn(),
}));
vi.mock("@/lib/hooks/use-settings", () => ({ useSettings: () => ({ settings: mocks.settings, updateSettings: mocks.updateSettings }) }));
vi.mock("@/lib/hooks/use-managed-policy", () => ({ useManagedPolicy: () => ({
  isSettingLocked: (key: string) => key in mocks.managed,
  getManagedValue: (key: string) => mocks.managed[key],
}) }));
vi.mock("@/components/ui/use-toast", () => ({ useToast: () => ({ toast: mocks.toast }) }));
vi.mock("@/lib/utils/tauri", () => ({ commands: {
  stopScreenpipe: mocks.stop, spawnScreenpipe: mocks.spawn,
  showShortcutReminder: mocks.showReminder, hideShortcutReminder: mocks.hideReminder,
} }));
import { TimelineSetting } from "../timeline-setting";

const toggle = () => screen.getByRole("switch", { name: "Timeline / rewind" });
const button = (name: string) => screen.getByRole("button", { name });
const restore = () => button("Enable timeline and screenshots");
const restarted = () => waitFor(() => expect(mocks.spawn).toHaveBeenCalledTimes(1));

describe("Timeline setting after onboarding", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.settings = { disableTimeline: true, disableScreenshots: true, disableVision: false, showScreenpipeShortcut: "Alt+S" };
    mocks.managed = {};
    mocks.updateSettings.mockReset().mockImplementation(async (patch) => { Object.assign(mocks.settings, patch); });
    mocks.stop.mockReset().mockResolvedValue({ status: "ok", data: null });
    mocks.spawn.mockReset().mockResolvedValue({ status: "ok", data: null });
    mocks.showReminder.mockReset().mockResolvedValue(undefined);
    mocks.hideReminder.mockReset().mockResolvedValue(undefined);
  });
  afterEach(() => cleanup());

  it("asks before restoring both flags and persists them before restart", async () => {
    render(<TimelineSetting />);
    fireEvent.click(toggle());
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(mocks.updateSettings).not.toHaveBeenCalled();
    expect(mocks.stop).not.toHaveBeenCalled();
    fireEvent.click(restore());
    await restarted();
    expect(mocks.updateSettings).toHaveBeenCalledTimes(1);
    expect(mocks.updateSettings).toHaveBeenCalledWith({ disableTimeline: false, disableScreenshots: false });
    expect(mocks.updateSettings.mock.invocationCallOrder[0]).toBeLessThan(mocks.stop.mock.invocationCallOrder[0]);
    expect(mocks.showReminder).toHaveBeenCalledWith("Alt+S");
    expect(screen.queryByText(/Screenshot capture is off/)).not.toBeInTheDocument();
  });

  it("allows existing history without silently resuming screenshot capture", async () => {
    render(<TimelineSetting />);
    fireEvent.click(toggle());
    fireEvent.click(button("Use existing history only"));
    await restarted();
    expect(mocks.updateSettings).toHaveBeenCalledWith({ disableTimeline: false });
    expect(mocks.settings.disableScreenshots).toBe(true);
    expect(screen.getByText(/Screenshot capture is off/)).toBeInTheDocument();
    expect(button("Enable screenshot capture")).toBeInTheDocument();
  });

  it("repairs an already-enabled timeline with capture still off", async () => {
    mocks.settings.disableTimeline = false;
    render(<TimelineSetting />);
    fireEvent.click(button("Enable screenshot capture"));
    expect(mocks.updateSettings).not.toHaveBeenCalled();
    fireEvent.click(restore());
    await restarted();
    expect(mocks.settings.disableScreenshots).toBe(false);
  });

  it("cancel leaves settings and the running engine untouched", () => {
    render(<TimelineSetting />);
    fireEvent.click(toggle());
    fireEvent.click(button("Cancel"));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(mocks.updateSettings).not.toHaveBeenCalled();
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(toggle()).toHaveAttribute("aria-checked", "false");
  });

  it("enables directly when screenshot capture is already on", async () => {
    mocks.settings.disableScreenshots = false;
    render(<TimelineSetting />);
    fireEvent.click(toggle());
    await restarted();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(mocks.updateSettings).toHaveBeenCalledWith({ disableTimeline: false });
  });

  it("disabling timeline preserves independent screenshot capture", async () => {
    mocks.settings.disableTimeline = false;
    mocks.settings.disableScreenshots = false;
    render(<TimelineSetting />);
    fireEvent.click(toggle());
    await restarted();
    expect(mocks.updateSettings).toHaveBeenCalledWith({ disableTimeline: true });
    expect(mocks.hideReminder).toHaveBeenCalledTimes(1);
  });

  it.each(["disableScreenshots", "screen_recording"])("respects %s policy", async (key) => {
    mocks.managed[key] = "true";
    render(<TimelineSetting />);
    fireEvent.click(toggle());
    expect(screen.queryByRole("button", { name: "Enable timeline and screenshots" })).not.toBeInTheDocument();
    expect(screen.getByText(/Your organization controls/)).toBeInTheDocument();
    fireEvent.click(button("Use existing history only"));
    await restarted();
    expect(mocks.updateSettings).toHaveBeenCalledWith({ disableTimeline: false });
  });

  it("does not override a locked timeline", () => {
    mocks.managed.disableTimeline = "true";
    render(<TimelineSetting />);
    expect(toggle()).toBeDisabled();
    fireEvent.click(toggle());
    expect(mocks.updateSettings).not.toHaveBeenCalled();
  });

  it("rechecks policy while the dialog is open", () => {
    const { rerender } = render(<TimelineSetting />);
    fireEvent.click(toggle());
    mocks.managed.disableScreenshots = "true";
    rerender(<TimelineSetting />);
    expect(screen.queryByRole("button", { name: "Enable timeline and screenshots" })).not.toBeInTheDocument();
    expect(mocks.updateSettings).not.toHaveBeenCalled();
  });

  it("preserves disabled screen context and explains the missing capture", async () => {
    mocks.settings.disableVision = true;
    render(<TimelineSetting />);
    fireEvent.click(toggle());
    expect(screen.getByText(/Screen context capture is off/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Enable timeline and screenshots" })).not.toBeInTheDocument();
    fireEvent.click(button("Use existing history only"));
    await restarted();
    expect(mocks.updateSettings).toHaveBeenCalledWith({ disableTimeline: false });
  });

  it("keeps a failed save retryable without restarting capture", async () => {
    mocks.updateSettings.mockRejectedValueOnce(new Error("disk full"));
    render(<TimelineSetting />);
    fireEvent.click(toggle());
    fireEvent.click(restore());
    expect(await screen.findByRole("alert")).toHaveTextContent("Couldn't save the change");
    expect(mocks.stop).not.toHaveBeenCalled();
    expect(mocks.showReminder).not.toHaveBeenCalled();
    fireEvent.click(restore());
    await restarted();
  });

  it("waits for persistence and collapses repeated clicks into one restart", async () => {
    let resolveSave!: () => void;
    mocks.updateSettings.mockImplementationOnce(() => new Promise<void>((resolve) => { resolveSave = resolve; }));
    render(<TimelineSetting />);
    fireEvent.click(toggle());
    const action = restore();
    fireEvent.click(action);
    fireEvent.click(action);
    expect(mocks.updateSettings).toHaveBeenCalledTimes(1);
    expect(mocks.stop).not.toHaveBeenCalled();
    resolveSave();
    await restarted();
    expect(mocks.stop).toHaveBeenCalledTimes(1);
  });

  it.each(["stop", "spawn"] as const)("handles a returned %s failure without claiming success", async (command) => {
    mocks[command].mockResolvedValueOnce({ status: "error", error: "not ready" });
    render(<TimelineSetting />);
    fireEvent.click(toggle());
    fireEvent.click(restore());
    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({ title: "Failed to restart screenpipe", variant: "destructive" })));
    expect(mocks.toast).not.toHaveBeenCalledWith(expect.objectContaining({ title: "Timeline enabled" }));
    if (command === "stop") expect(mocks.spawn).not.toHaveBeenCalled();
  });
});
