// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  settings: {} as Record<string, unknown>,
  updateSettings: vi.fn(),
}));
vi.mock("@/lib/hooks/use-settings", () => ({
  useSettings: () => mocks,
}));
vi.mock("../notification-pipe-controls", () => ({
  NotificationPipeControls: () => null,
}));

import { NotificationsSettings } from "../notifications-settings";

beforeEach(() => {
  mocks.settings = {};
  mocks.updateSettings.mockReset();
});
afterEach(cleanup);

it("saves a numeric lead time without overwriting other notification choices", () => {
  mocks.settings = { notificationPrefs: { meetingReminders: true, displayChanges: false } };
  const view = render(<NotificationsSettings />);
  const timing = screen.getByLabelText("Meeting reminder timing");
  expect(timing).toHaveValue("30");
  fireEvent.change(timing, { target: { value: "120" } });
  expect(mocks.updateSettings).toHaveBeenCalledWith({
    notificationPrefs: expect.objectContaining({
      meetingReminderLeadSeconds: 120, meetingReminders: true, displayChanges: false,
    }),
  });
  mocks.settings = mocks.updateSettings.mock.calls[0][0];
  view.unmount();
  render(<NotificationsSettings />);
  expect(screen.getByLabelText("Meeting reminder timing")).toHaveValue("120");
});

it("preserves the legacy meeting opt-out until reminders are explicitly enabled", () => {
  mocks.settings = { notificationPrefs: { meetingLiveNotes: false } };
  const view = render(<NotificationsSettings />);
  expect(screen.getByLabelText("Meeting reminder timing")).toBeDisabled();
  mocks.settings = { notificationPrefs: { meetingLiveNotes: false, meetingReminders: true } };
  view.rerender(<NotificationsSettings />);
  expect(screen.getByLabelText("Meeting reminder timing")).toBeEnabled();
});
