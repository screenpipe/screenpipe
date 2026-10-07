// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { describe, expect, it } from "vitest";
import {
  isAudioMediaPath,
  isMediaAddress,
  isMediaFilePath,
  normalizeLocalMediaMarkdown,
  normalizeMediaFilePath,
} from "./media-file-path";

describe("normalizeMediaFilePath", () => {
  it("extracts a Windows wav path from surrounding chat text", () => {
    const path = String.raw`audio file: C:\Users\Hugo Azevedo - LLG\.screenpipe\data\Microfone (C922 Pro Stream Webcam)\chunk.wav`;

    expect(normalizeMediaFilePath(path)).toBe(
      String.raw`C:\Users\Hugo Azevedo - LLG\.screenpipe\data\Microfone (C922 Pro Stream Webcam)\chunk.wav`,
    );
  });

  it("decodes encoded Windows file URLs", () => {
    const path = "file:///C:/Users/Hugo%20Azevedo/.screenpipe/data/audio.wav";

    expect(normalizeMediaFilePath(path)).toBe(
      "C:/Users/Hugo Azevedo/.screenpipe/data/audio.wav",
    );
  });

  it("preserves the leading slash when decoding Unix file URLs", () => {
    const path = "file:///Users/ansh/.screenpipe/data/audio%20clip.wav";

    expect(normalizeMediaFilePath(path)).toBe(
      "/Users/ansh/.screenpipe/data/audio clip.wav",
    );
  });

  it("normalizes Unix file URLs with non-standard slash counts", () => {
    expect(
      normalizeMediaFilePath("file:/Users/ansh/.screenpipe/data/audio%20clip.wav"),
    ).toBe("/Users/ansh/.screenpipe/data/audio clip.wav");
    expect(
      normalizeMediaFilePath("file:////Users/ansh/.screenpipe/data/audio%20clip.wav"),
    ).toBe("/Users/ansh/.screenpipe/data/audio clip.wav");
  });

  it("preserves the full absolute Unix path", () => {
    const path = "/Users/ansh/.screenpipe/data/audio clip.wav";

    expect(normalizeMediaFilePath(path)).toBe(
      "/Users/ansh/.screenpipe/data/audio clip.wav",
    );
  });

  it("trims outer whitespace before stripping surrounding quotes", () => {
    const path = '  "file:///Users/ansh/.screenpipe/data/audio%20clip.wav"  ';

    expect(normalizeMediaFilePath(path)).toBe(
      "/Users/ansh/.screenpipe/data/audio clip.wav",
    );
  });
});

describe("isAudioMediaPath", () => {
  it("recognizes audio by extension", () => {
    expect(isAudioMediaPath(String.raw`C:\Users\me\.screenpipe\data\microfone.wav`)).toBe(true);
    expect(isAudioMediaPath("/tmp/chunk.mp4")).toBe(false);
  });

  it("recognizes Screenpipe audio chunks stored in mp4 containers", () => {
    expect(
      isAudioMediaPath(
        "/Users/ansh/.screenpipe/data/System Audio (output)_2026-05-25_11-27-00.mp4",
      ),
    ).toBe(true);
    expect(
      isAudioMediaPath(
        String.raw`C:\Users\Hugo\.screenpipe\data\Microfone (C922 Pro Stream Webcam) (input)_2026-05-25_21-42-22.mp4`,
      ),
    ).toBe(true);
    expect(isAudioMediaPath("/Users/ansh/.screenpipe/data/monitor_2026-05-25_11-27-00.mp4")).toBe(false);
  });
});

describe("isMediaFilePath", () => {
  it("recognizes supported media extensions", () => {
    expect(isMediaFilePath("/tmp/chunk.mp4")).toBe(true);
    expect(isMediaFilePath("/tmp/chunk.wav")).toBe(true);
    expect(isMediaFilePath("/tmp/chunk.txt")).toBe(false);
  });

  it("accepts every location the media reader can open", () => {
    expect(isMediaFilePath("~/Downloads/clip.mp4")).toBe(true);
    expect(isMediaFilePath(String.raw`~\Downloads\clip.mp4`)).toBe(true);
    expect(isMediaFilePath(String.raw`C:\Users\me\clip.mp4`)).toBe(true);
    expect(isMediaFilePath("c:/Users/me/clip.mp4")).toBe(true);
    expect(isMediaFilePath("file:///Users/me/clip.mp4")).toBe(true);
    expect(
      isMediaFilePath("/Users/ansh/.screenpipe/data/System Audio (output)_2026-05-25_11-27-00.mp4"),
    ).toBe(true);
    // The player strips wrapping quotes before reading, so the path inside counts.
    expect(isMediaFilePath('"/Users/me/clip.mp4"')).toBe(true);
  });

  it("accepts a drive path with doubled backslashes, the way markdown escapes them", () => {
    // Only two separators at the very start make a network share; Windows
    // reads `C:\\Users` as `C:\Users`.
    expect(isMediaFilePath(String.raw`C:\\Users\\me\\clip.mp4`)).toBe(true);
    expect(isMediaFilePath(String.raw`C:\\nas\recordings\clip.mp4`)).toBe(true);
    expect(isMediaFilePath("C://Users/me/clip.mp4")).toBe(true);
    expect(isMediaFilePath("C:%5C%5CUsers%5C%5Cme%5C%5Cclip.mp4")).toBe(true);
  });

  it("reads percent-encoded link addresses the way the media reader will", () => {
    expect(isMediaFilePath("C:%5CUsers%5Cme%5Cclip.mp4")).toBe(true);
    expect(isMediaFilePath("~%5CDownloads%5Cclip.mp4")).toBe(true);
  });

  it("rejects names with no location to read from", () => {
    expect(isMediaFilePath("demo.mp4")).toBe(false);
    expect(isMediaFilePath(".mp4")).toBe(false);
    expect(isMediaFilePath("clips/demo.mp4")).toBe(false);
    expect(isMediaFilePath("./demo.mp4")).toBe(false);
    expect(isMediaFilePath("https://example.com/demo.mp4")).toBe(false);
    expect(isMediaFilePath("//cdn.example.com/demo.mp4")).toBe(false);
  });

  it("rejects network shares, which the reader would fetch from their host", () => {
    for (const path of [
      String.raw`\\nas\recordings\clip.mp4`,
      "//nas/recordings/clip.mp4",
      String.raw`/\nas\recordings\clip.mp4`,
      String.raw`~/\\nas\recordings\clip.mp4`,
      "~//nas/recordings/clip.mp4",
      "%5C%5Cnas%5Crecordings%5Cclip.mp4",
      "/%5C%5Cnas%5Crecordings%5Cclip.mp4",
      "~%2F%5C%5Cnas%5Crecordings%5Cclip.mp4",
    ]) {
      expect(isMediaFilePath(path), path).toBe(false);
    }
  });

  it("rejects text that is not one concrete file", () => {
    expect(isMediaFilePath("/Users/me/a.mp4\n/Users/me/b.mp4")).toBe(false);
    expect(isMediaFilePath("~/.screenpipe/data/monitor_*.mp4")).toBe(false);
    expect(isMediaFilePath("~/.screenpipe/data/monitor_<id>.mp4")).toBe(false);
    expect(isMediaFilePath("~/.screenpipe/data/*.mp4")).toBe(false);
    expect(isMediaFilePath("/Users/me/Movies/clip*.mp4")).toBe(false);
    expect(
      isMediaFilePath("~/.screenpipe/data/MacBook Pro Microphone (input)_2026-09-29_10-*-00.mp4"),
    ).toBe(false);
    expect(isMediaFilePath("~/.screenpipe/data/<device> (input)_<timestamp>.mp4")).toBe(false);
  });

  it("accepts a device recording whose name has <, > or *", () => {
    // Audio recordings are named after the device, and a Bluetooth device can
    // be renamed to anything.
    expect(
      isMediaFilePath("/Users/me/.screenpipe/data/Sam's Buds <3 (input)_2026-09-29_10-00-00.mp4"),
    ).toBe(true);
    expect(
      isMediaFilePath("/Users/me/.screenpipe/data/Mic > Loopback (input)_2026-09-29_10-00-00.mp4"),
    ).toBe(true);
    expect(
      isMediaFilePath("/Users/me/.screenpipe/data/Beats*Pro (input)_2026-09-29_10-00-00.mp4"),
    ).toBe(true);
    expect(
      isMediaFilePath("/Users/me/.screenpipe/data/*NSYNC Speaker (output)_2026-09-29_10-00-00.mp4"),
    ).toBe(true);
    expect(
      isMediaFilePath("/Users/me/.screenpipe/data/Mic <-> Loopback (input)_2026-09-29_10-00-00.mp4"),
    ).toBe(true);
  });

  it("rejects several paths written on one line", () => {
    expect(isMediaFilePath("/Users/me/a.mp4, /Users/me/b.mp4")).toBe(false);
    expect(isMediaFilePath("~/a.mp4 ~/b.mp4")).toBe(false);
    expect(isMediaFilePath(String.raw`C:\clips\a.mp4 C:\clips\b.mp4`)).toBe(false);
  });

  it("rejects a path the player would read only part of", () => {
    // The player stops at the first media extension and would open `/Users/me/clip.mp4`.
    expect(isMediaFilePath("/Users/me/clip.mp4.old.mp4")).toBe(false);
  });
});

describe("isMediaAddress", () => {
  it("recognizes a media address wherever it points", () => {
    expect(isMediaAddress("demo.mp4")).toBe(true);
    expect(isMediaAddress("https://example.com/clip.mp4?t=1")).toBe(true);
    expect(isMediaAddress("clips/demo.WEBM#t=30")).toBe(true);
  });

  it("ignores an extension that only appears in the query or the middle", () => {
    expect(isMediaAddress("https://example.com/cover.png?from=clip.mp4")).toBe(false);
    expect(isMediaAddress("/Users/me/clip.mp4.txt")).toBe(false);
  });
});

describe("normalizeLocalMediaMarkdown", () => {
  it("wraps local media image paths that contain spaces and parentheses", () => {
    const markdown =
      "- When you were talking: ![](/Users/ansh/.screenpipe/data/System Audio (output)_2026-05-25_11-27-00.mp4)";

    expect(normalizeLocalMediaMarkdown(markdown)).toBe(
      "- When you were talking: ![](<\/Users/ansh/.screenpipe/data/System Audio (output)_2026-05-25_11-27-00.mp4>)",
    );
  });

  it("wraps local media links that contain spaces and parentheses", () => {
    const markdown =
      "[play clip](/Users/ansh/.screenpipe/data/System Audio (output)_2026-05-25_11-27-00.mp4)";

    expect(normalizeLocalMediaMarkdown(markdown)).toBe(
      "[play clip](</Users/ansh/.screenpipe/data/System Audio (output)_2026-05-25_11-27-00.mp4>)",
    );
  });
});

describe("normalizeMediaFilePath — edge cases", () => {
  it("keeps the original string when percent-escapes are malformed", () => {
    // decodeURIComponent throws on the dangling %A; the catch keeps the input.
    expect(normalizeMediaFilePath("/Users/me/bad%A.mp4")).toBe(
      "/Users/me/bad%A.mp4",
    );
  });

  it("returns the cleaned path unchanged when there is no media extension", () => {
    expect(normalizeMediaFilePath("/Users/me/notes.txt")).toBe(
      "/Users/me/notes.txt",
    );
  });

  it("returns an empty string for empty input", () => {
    expect(normalizeMediaFilePath("")).toBe("");
  });

  it("strips surrounding backticks", () => {
    expect(normalizeMediaFilePath("`/Users/ansh/clip.mp4`")).toBe(
      "/Users/ansh/clip.mp4",
    );
  });

  it("matches the media extension case-insensitively", () => {
    expect(normalizeMediaFilePath("/Users/ansh/Clip.MP4")).toBe(
      "/Users/ansh/Clip.MP4",
    );
  });

  it("extracts a Windows path written with forward slashes from surrounding text", () => {
    expect(normalizeMediaFilePath("see C:/Users/me/clip.webm now")).toBe(
      "C:/Users/me/clip.webm",
    );
  });

  it("extracts a Unix audio-chunk path with spaces and parens from chat text", () => {
    expect(
      normalizeMediaFilePath(
        "recording at /Users/ansh/.screenpipe/data/Mic (input)_2026-05-25_21-42-22.mp4 done",
      ),
    ).toBe("/Users/ansh/.screenpipe/data/Mic (input)_2026-05-25_21-42-22.mp4");
  });

  it("preserves the leading ~ on a home-relative path", () => {
    // Regression: the Unix matcher anchored on the first `/`, dropping the `~`
    // and turning `~/Downloads/clip.mp4` into a non-existent `/Downloads/clip.mp4`.
    expect(normalizeMediaFilePath("~/Downloads/audio_17_7pm-8pm.mp4")).toBe(
      "~/Downloads/audio_17_7pm-8pm.mp4",
    );
  });

  it("extracts a home-relative path from surrounding chat text", () => {
    expect(
      normalizeMediaFilePath("saved to ~/Downloads/clip.mp4 just now"),
    ).toBe("~/Downloads/clip.mp4");
  });

  it("strips backticks around a home-relative path", () => {
    expect(normalizeMediaFilePath("`~/Downloads/clip.mp4`")).toBe(
      "~/Downloads/clip.mp4",
    );
  });

  it("preserves a Windows-style home-relative path (backslashes)", () => {
    // The backend only expands `~\` on Windows; the frontend just keeps the
    // prefix intact so the right home dir gets joined there.
    expect(normalizeMediaFilePath(String.raw`~\Downloads\clip.mp4`)).toBe(
      String.raw`~\Downloads\clip.mp4`,
    );
  });

  it("does not treat a mid-path ~ as a home reference", () => {
    // The `~` here ends a directory name; it must not be mistaken for `~/`.
    expect(normalizeMediaFilePath("/Users/me~/clip.mp4")).toBe(
      "/Users/me~/clip.mp4",
    );
  });
});

describe("isAudioMediaPath / isMediaFilePath — edge cases", () => {
  it("treats ogg/m4a/wav (any case) as audio but not webm or video mp4", () => {
    expect(isAudioMediaPath("/x/a.ogg")).toBe(true);
    expect(isAudioMediaPath("/x/a.M4A")).toBe(true);
    expect(isAudioMediaPath("/x/a.WAV")).toBe(true);
    expect(isAudioMediaPath("/x/clip.webm")).toBe(false);
  });

  it("isMediaFilePath is case-insensitive and rejects non-media extensions", () => {
    expect(isMediaFilePath("/x/a.MP4")).toBe(true);
    expect(isMediaFilePath("/x/a.OGG")).toBe(true);
    expect(isMediaFilePath("/x/a.png")).toBe(false);
  });
});

describe("normalizeLocalMediaMarkdown — edge cases", () => {
  it("leaves an already-angle-bracket-wrapped media link unchanged", () => {
    const md = "![](</Users/a/System Audio (output).mp4>)";
    expect(normalizeLocalMediaMarkdown(md)).toBe(md);
  });

  it("escapes a literal > inside the wrapped path", () => {
    expect(normalizeLocalMediaMarkdown("[a](/Users/a/we>ird.mp4)")).toBe(
      "[a](</Users/a/we%3Eird.mp4>)",
    );
  });

  it("wraps a Windows media path inside a link", () => {
    expect(
      normalizeLocalMediaMarkdown(String.raw`[v](C:\Users\me\clip.mp4)`),
    ).toBe(String.raw`[v](<C:\Users\me\clip.mp4>)`);
  });

  it("wraps a Windows device recording whose name nests parentheses", () => {
    const path = String.raw`C:\Users\me\.screenpipe\data\Speakers (Realtek(R) Audio) (output)_2026-05-25_11-27-00.mp4`;
    expect(normalizeLocalMediaMarkdown(`[call](${path})`)).toBe(`[call](<${path}>)`);
  });

  it("wraps only the media link when another link comes first on the line", () => {
    expect(
      normalizeLocalMediaMarkdown(
        "Saved [notes](/Users/me/notes.md) and [call](/Users/me/System Audio (output).mp4).",
      ),
    ).toBe("Saved [notes](/Users/me/notes.md) and [call](</Users/me/System Audio (output).mp4>).");
  });

  it("leaves a link alone when a media path only appears in a note after it", () => {
    const md = "See [notes](/Users/me/notes.md) (audio: /Users/me/clip.mp4).";
    expect(normalizeLocalMediaMarkdown(md)).toBe(md);
  });
});
