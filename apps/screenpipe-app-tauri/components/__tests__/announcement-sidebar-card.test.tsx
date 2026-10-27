// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AnnouncementSidebarCard } from "@/components/announcement-sidebar-card";
import { parseAnnouncement } from "@/lib/announcements";

const card = parseAnnouncement({
  id: "card", surface: "sidebar", sidebarStyle: "card",
  title: "Explore workflows", body: "See your workflows.",
  image: { url: "https://screenpipe.com/card.png", alt: "Workflow preview" },
  autoDismissMs: 1,
})!;

describe("sidebar announcement card", () => {
  it("has separate keyboard-accessible open and dismiss actions, with no timer", () => {
    vi.useFakeTimers();
    try {
      const onOpen = vi.fn(), onDismiss = vi.fn();
      render(<AnnouncementSidebarCard announcement={card} onOpen={onOpen} onDismiss={onDismiss} />);
      vi.advanceTimersByTime(60000);
      expect(onDismiss).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Read announcement: Explore workflows" }));
      expect(onOpen).toHaveBeenCalledOnce();
      expect(onDismiss).not.toHaveBeenCalled();
      fireEvent.click(screen.getByRole("button", { name: "Dismiss announcement" }));
      expect(onDismiss).toHaveBeenCalledOnce();
      expect(onOpen).toHaveBeenCalledOnce();
    } finally { vi.useRealTimers(); }
  });
  it("falls back to a text card after image failure and retries a replacement image", () => {
    const props = { onOpen: vi.fn(), onDismiss: vi.fn() };
    const { rerender } = render(<AnnouncementSidebarCard announcement={card} {...props} />);
    fireEvent.error(screen.getByRole("img"));
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
    expect(screen.getByText("Explore workflows")).toBeVisible();
    rerender(<AnnouncementSidebarCard announcement={{ ...card, image: { url: "https://screenpipe.com/new.png", alt: "New preview" } }} {...props} />);
    expect(screen.getByRole("img", { name: "New preview" })).toBeVisible();
  });
});
