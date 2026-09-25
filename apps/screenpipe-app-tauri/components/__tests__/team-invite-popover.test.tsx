// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import React from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TeamInvitePopover } from "../team-invite-popover";
import type { TeamEntry } from "@/lib/hooks/use-team-summary";
const team: TeamEntry = {
  kind: "team",
  label: "Example Studio",
  href: "https://screenpipe.com/team-dashboard?team_id=studio",
  teamId: "studio",
  canInvite: true,
};
const recipient = "sam@example.com";
const reply = (body: unknown, status = 200) => ({
  ok: status < 400,
  status,
  json: async () => body,
});
const renderMenu = (entry = team, token: string | null = "fixture") => {
  const manage = vi.fn();
  const view = render(
    <TeamInvitePopover entry={entry} token={token} onManage={manage}>
      <button>Team</button>
    </TeamInvitePopover>,
  );
  fireEvent.click(screen.getByRole("button", { name: "Team", exact: true }));
  return { ...view, manage };
};
const send = () => {
  fireEvent.change(screen.getByLabelText("Teammate email"), {
    target: { value: recipient },
  });
  fireEvent.submit(screen.getByLabelText("Teammate email").closest("form")!);
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
describe("quick team invitation", () => {
  it("focuses email on open and sends only on explicit submission", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        reply({ invite: { email: recipient }, email_sent: true }),
      );
    vi.stubGlobal("fetch", fetcher);
    const { manage } = renderMenu();
    expect(screen.getByLabelText("Teammate email")).toHaveFocus();
    expect(fetcher).not.toHaveBeenCalled();
    send();
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent(recipient),
    );
    expect(fetcher).toHaveBeenCalledWith(
      "https://screenpipe.com/api/team/billing/seat-invite?team_id=studio",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ email: recipient }),
        headers: {
          Authorization: "Bearer fixture",
          "Content-Type": "application/json",
        },
      }),
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Manage team on the web" }),
    );
    expect(manage).toHaveBeenCalledOnce();
  });
  it("blocks duplicate submits while pending", async () => {
    const fetcher = vi.fn().mockReturnValue(new Promise(() => {}));
    vi.stubGlobal("fetch", fetcher);
    renderMenu();
    send();
    send();
    expect(fetcher).toHaveBeenCalledOnce();
    expect(screen.getByLabelText("Teammate email")).toBeDisabled();
  });
  it.each([
    "this user is already on the team",
    "no open seats",
    "admin required",
  ])("shows server refusal: %s", async (error) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(reply({ error }, 409)));
    renderMenu();
    send();
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent(error),
    );
    expect(screen.getByLabelText("Teammate email")).toHaveValue(recipient);
  });
  it("does not claim email delivery or retry a persisted invite when email failed", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        reply({ invite: { email: recipient }, email_sent: false }),
      );
    vi.stubGlobal("fetch", fetcher);
    renderMenu();
    send();
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("Email delivery couldn’t be confirmed"),
    );
    expect(
      screen.getByRole("button", { name: "Send invitation" }),
    ).toBeDisabled();
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it.each([reply({ error: "server failed" }, 500), reply({})])(
    "keeps unknown outcomes from being replayed",
    async (response) => {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
      renderMenu();
      send();
      await waitFor(() =>
        expect(screen.getByRole("alert")).toHaveTextContent("couldn’t confirm"),
      );
      expect(
        screen.getByRole("button", { name: "Send invitation" }),
      ).toBeDisabled();
    },
  );
  it("aborts a timed-out send and directs the user to check the web", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url, options) =>
          new Promise((_resolve, reject) =>
            options.signal.addEventListener("abort", () =>
              reject(new Error("aborted")),
            ),
          ),
      ),
    );
    renderMenu();
    send();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000);
    });
    expect(screen.getByRole("alert")).toHaveTextContent("couldn’t confirm");
  });
  it("ignores a completion after unmount", async () => {
    let resolve!: (value: unknown) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn().mockReturnValue(
        new Promise((r) => {
          resolve = r;
        }),
      ),
    );
    const view = renderMenu();
    send();
    view.unmount();
    renderMenu({ ...team, kind: "no-team", canInvite: false });
    await act(async () =>
      resolve(reply({ invite: { email: recipient }, email_sent: true })),
    );
    expect(screen.queryByRole("status")).toBeNull();
  });
  it.each([
    "signed-out",
    "no-team",
    "enterprise",
    "unavailable",
    "team",
  ] as const)("shows a web fallback for %s without making requests", (kind) => {
    const fetcher = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    renderMenu({ ...team, kind, canInvite: false });
    expect(screen.queryByLabelText("Teammate email")).toBeNull();
    expect(
      screen.getByRole("button", { name: "Manage team on the web" }),
    ).toBeVisible();
    expect(fetcher).not.toHaveBeenCalled();
  });
});

const seatQuote = { quote_token: "signed-fixture", team_name: "Example Studio", from: 1, to: 2, amount_due_today: 12, new_total: 100, currency: "usd", interval: "month", interval_count: 1 };
const fullSeat = () => reply({ code: "NO_AVAILABLE_SEATS", error: "No seats" }, 400);
async function showPrice(fetcher: ReturnType<typeof vi.fn>) {
  vi.stubGlobal("fetch", fetcher);
  renderMenu(); send();
  await screen.findByRole("button", { name: "Add seat and send invite" });
}
it("Enter reveals pricing without buying; explicit confirmation buys once then sends", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(fullSeat()).mockResolvedValueOnce(reply(seatQuote)).mockResolvedValueOnce(reply({ purchased: true, seats: 2 })).mockResolvedValueOnce(reply({ invite: { email: recipient }, email_sent: true }));
  await showPrice(fetcher);
  expect(screen.getByText("$12.00")).toBeVisible();
  expect(screen.getByText("$100.00 / month")).toBeVisible();
  send(); expect(fetcher).toHaveBeenCalledTimes(2);
  fireEvent.click(screen.getByRole("button", { name: "Add seat and send invite" }));
  await screen.findByText(`Invite sent to ${recipient}`);
  expect(fetcher).toHaveBeenCalledTimes(4);
  expect(fetcher.mock.calls[2][0]).toContain("/add-seat?team_id=studio");
  expect(JSON.parse(fetcher.mock.calls[2][1].body)).toEqual(seatQuote);
  expect(fetcher.mock.calls[3][0]).toContain("/seat-invite?team_id=studio");
});
it("canceling the quoted purchase does not charge or send", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(fullSeat()).mockResolvedValueOnce(reply(seatQuote));
  await showPrice(fetcher); fireEvent.click(screen.getByRole("button", { name: "Cancel", exact: true }));
  expect(screen.queryByText("Due now")).not.toBeInTheDocument(); expect(fetcher).toHaveBeenCalledTimes(2);
});
it.each([402, 409, 503])("does not send or retry billing after purchase response %s", async status => {
  const fetcher = vi.fn().mockResolvedValueOnce(fullSeat()).mockResolvedValueOnce(reply(seatQuote)).mockResolvedValueOnce(reply({ error: "Review billing" }, status));
  await showPrice(fetcher); fireEvent.click(screen.getByRole("button", { name: "Add seat and send invite" }));
  await screen.findByText("Review billing"); send(); expect(fetcher).toHaveBeenCalledTimes(3);
  expect(screen.getByRole("button", { name: "Send invitation" })).toBeDisabled();
});
it("never purchases again when the seat was bought but the invitation failed", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(fullSeat()).mockResolvedValueOnce(reply(seatQuote)).mockResolvedValueOnce(reply({ purchased: true, seats: 2 })).mockResolvedValueOnce(fullSeat());
  await showPrice(fetcher); fireEvent.click(screen.getByRole("button", { name: "Add seat and send invite" }));
  await screen.findByText(/The seat was purchased/); send(); expect(fetcher).toHaveBeenCalledTimes(4);
  expect(screen.queryByRole("button", { name: "Add seat and send invite" })).not.toBeInTheDocument();
});
it("an unknown purchase outcome directs to billing without sending an invitation", async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(fullSeat()).mockResolvedValueOnce(reply(seatQuote)).mockRejectedValueOnce(new Error("offline"));
  await showPrice(fetcher); fireEvent.click(screen.getByRole("button", { name: "Add seat and send invite" }));
  await screen.findByText(/couldn’t confirm the purchase/); expect(fetcher).toHaveBeenCalledTimes(3);
});
