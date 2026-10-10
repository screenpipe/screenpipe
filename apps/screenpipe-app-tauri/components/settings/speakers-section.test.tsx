// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import React from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ localFetch: vi.fn() }));

vi.mock("@/lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api")>()),
  localFetch: mocks.localFetch,
}));
vi.mock("@/lib/chat-utils", () => ({ showChatWithPrefill: vi.fn() }));

import { SpeakersSection } from "@/components/settings/speakers-section";

const named = [{ id: 1, name: "Alice", metadata: "{}" }];
const unnamed = [
  { id: 10, name: "", metadata: "{}" },
  { id: 11, name: "", metadata: "{}" },
];

function json(body: unknown) {
  return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
}

// Lists answer at once; `similar` answers the voice-matching lookups.
function serve(
  lists: { named: unknown[]; unnamed: unknown[] },
  similar: () => Promise<Response> = () => json([]),
) {
  mocks.localFetch.mockImplementation((path: string) =>
    path.startsWith("/speakers/search")
      ? json(lists.named)
      : path.startsWith("/speakers/unnamed")
        ? json(lists.unnamed)
        : similar(),
  );
}

function similarCalls() {
  return mocks.localFetch.mock.calls.filter(([path]) =>
    String(path).startsWith("/speakers/similar"),
  ).length;
}

async function settle() {
  await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("SpeakersSection after a tab switch", () => {
  it("runs the voice-matching lookups once on a return visit", async () => {
    serve({ named, unnamed });
    render(<SpeakersSection />);
    await screen.findByText(/Pending identification/);
    await settle();
    const firstVisit = similarCalls();
    expect(firstVisit).toBe(3);
    // Switching tabs unmounts the section.
    cleanup();
    mocks.localFetch.mockClear();

    render(<SpeakersSection />);
    await screen.findByText(/Pending identification/);
    await settle();

    expect(similarCalls()).toBe(firstVisit);
  });

  it("loads from the skeleton again when the last visit's load failed", async () => {
    mocks.localFetch.mockImplementation(() =>
      Promise.resolve(new Response("down", { status: 503 })),
    );
    render(<SpeakersSection />);
    expect(
      await screen.findByText("No speakers detected yet"),
    ).toBeInTheDocument();
    cleanup();

    mocks.localFetch.mockImplementation(() => new Promise(() => undefined));
    render(<SpeakersSection />);

    expect(screen.queryByText("No speakers detected yet")).toBeNull();
    expect(document.querySelector('[class*="animate-pulse"]')).not.toBeNull();
  });

  it("does not report no speakers while unnamed ones are being grouped", async () => {
    serve({ named: [], unnamed }, () => new Promise(() => undefined));
    render(<SpeakersSection />);

    expect(
      await screen.findByText("2 unidentified speakers"),
    ).toBeInTheDocument();
    await settle();
    expect(screen.queryByText("No speakers detected yet")).toBeNull();
  });
});
