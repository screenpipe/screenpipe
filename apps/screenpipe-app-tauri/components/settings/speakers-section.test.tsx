// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { SpeakersSection } from "./speakers-section";

vi.mock("@/lib/api", () => ({
  appendAuthToken: (url: string) => url,
  ensureApiReady: async () => {},
  getApiBaseUrl: () => "http://localhost:3030",
  localFetch: async (path: string) =>
    Response.json(
      path === "/speakers/search"
        ? [{
            id: 1,
            name: "Jamie",
            metadata: JSON.stringify({
              audio_samples: [{ audio_chunk_id: 42, start_time: 9, end_time: 11 }],
            }),
          }]
        : [],
    ),
  redactApiUrlForLogs: (url: string) => url,
}));

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("lets a slow-loading speaker sample play until the audio ends", async () => {
  const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => {});
  const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockImplementation(
    () => new Promise<void>((resolve) => setTimeout(resolve, 2500)),
  );
  const { container } = render(<SpeakersSection />);
  const audio = await waitFor(() => {
    const element = container.querySelector("audio[src]");
    expect(element).toBeInstanceOf(HTMLAudioElement);
    return element as HTMLAudioElement;
  });
  const button = audio.parentElement!.querySelector("button")!;

  vi.useFakeTimers();
  fireEvent.click(button);
  expect(play).toHaveBeenCalledOnce();
  await act(() => vi.advanceTimersByTimeAsync(2500));
  expect(pause).not.toHaveBeenCalled();
  expect(button.querySelector(".lucide-square")).toBeTruthy();

  fireEvent.ended(audio);
  expect(button.querySelector(".lucide-play")).toBeTruthy();
});
