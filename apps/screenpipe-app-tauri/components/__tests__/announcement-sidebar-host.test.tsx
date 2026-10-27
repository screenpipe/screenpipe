// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnnouncementHost } from "@/components/announcement-host";
import { parseAnnouncement } from "@/lib/announcements";

const state = vi.hoisted(() => ({
  announcement: null as unknown,
  dismiss: vi.fn(), activateCta: vi.fn(), reportShown: vi.fn(),
  reportOpened: vi.fn(), submitSurvey: vi.fn(),
}));
vi.mock("@/lib/hooks/use-announcement", () => ({ useAnnouncement: () => state }));
vi.mock("@/lib/utils/is-primary-window", () => ({ isPrimaryWindow: () => true }));

let slot: HTMLElement;
beforeEach(() => {
  vi.clearAllMocks();
  slot = document.createElement("div");
  slot.id = "announcement-sidebar-slot";
  document.body.appendChild(slot);
  state.announcement = parseAnnouncement({ id: "card", surface: "sidebar", sidebarStyle: "card", title: "Explore workflows", body: "Details about workflows." });
});
afterEach(() => slot.remove());

describe("sidebar card host", () => {
  it("opens details on demand and closing details preserves the card", async () => {
    render(<AnnouncementHost />);
    await waitFor(() => expect(screen.getByTestId("announcement-sidebar-card")).toBeVisible());
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Read announcement: Explore workflows" }));
    expect(screen.getByRole("dialog")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Got it" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(state.dismiss).not.toHaveBeenCalled();
    expect(screen.getByTestId("announcement-sidebar-card")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss announcement" }));
    expect(state.dismiss).toHaveBeenCalledOnce();
  });
  it("activates the configured CTA directly without opening a modal", async () => {
    state.announcement = { ...(state.announcement as object), cta: { label: "Explore", route: "/home?mode=workflows" } };
    render(<AnnouncementHost />);
    await waitFor(() => expect(screen.getByRole("button", { name: "Explore" })).toBeVisible());
    fireEvent.click(screen.getByRole("button", { name: "Explore" }));
    expect(state.activateCta).toHaveBeenCalledOnce();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(state.dismiss).not.toHaveBeenCalled();
  });
});
