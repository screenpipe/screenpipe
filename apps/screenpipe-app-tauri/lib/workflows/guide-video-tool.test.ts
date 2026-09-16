// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { test, expect } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseVideoScenes,
  sceneCaptions,
  renderGuideVideo,
} from "../../../../packages/workflows-ui/src/guide-video-tool";

test("rejects remote images and unbounded narration", () => {
  expect(() =>
    parseVideoScenes([
      {
        title: "Source",
        narration: "Read",
        image: "https://example.com/private.png",
      },
    ]),
  ).toThrow();
  expect(() =>
    parseVideoScenes([
      { title: "Source", narration: "x".repeat(801), image: null },
    ]),
  ).toThrow();
  expect(() => parseVideoScenes([])).toThrow();
  expect(
    sceneCaptions({
      title: "{\\pos(0,0)}Text",
      narration: "Safe captions",
      image: null,
    }),
  ).not.toContain("{\\pos");
});
test.skipIf(!Bun.which(process.env.SCREENPIPE_FFMPEG_PATH || "ffmpeg"))(
  "renders a real two-scene MP4 with local FFmpeg and stops before narration on cancellation",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "guide-video-test-"));
    const jobId = crypto.randomUUID();
    const dir = join(root, jobId);
    await mkdir(dir);
    try {
      const scenes = [
        {
          title: "Collect sources",
          narration: "Add your sources to the research brief.",
          image: null,
        },
        {
          title: "Compare findings",
          narration: "Record a claim beside each supporting link.",
          image: null,
        },
      ];
      const ffmpeg = process.env.SCREENPIPE_FFMPEG_PATH || "ffmpeg";
      const picture = Bun.spawnSync([
        ffmpeg,
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=white:s=640x360",
        "-frames:v",
        "1",
        "-f",
        "image2pipe",
        "-c:v",
        "png",
        "-",
      ]);
      expect(picture.exitCode).toBe(0);
      (scenes[0] as { image: string | null }).image =
        `data:image/png;base64,${Buffer.from(picture.stdout).toString("base64")}`;
      await writeFile(join(dir, "scenes.json"), JSON.stringify(scenes));
      const voice = Bun.spawnSync([
        ffmpeg,
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=1",
        "-f",
        "mp3",
        "-",
      ]);
      expect(voice.exitCode).toBe(0);
      let narrated = 0;
      const options = {
        root,
        jobId,
        ffmpeg,
        signal: new AbortController().signal,
        narrate: async () => {
          narrated++;
          return new Uint8Array(voice.stdout);
        },
      };
      expect(await renderGuideVideo(options)).toMatchObject({
        jobId,
        filename: "guide.mp4",
        scenes: 2,
      });
      const output = await readFile(join(dir, "guide.mp4"));
      expect(output.subarray(4, 8).toString()).toBe("ftyp");
      expect(output.length).toBeGreaterThan(10000);
      expect(narrated).toBe(2);
      const aborted = new AbortController();
      aborted.abort();
      await expect(
        renderGuideVideo({ ...options, signal: aborted.signal }),
      ).rejects.toThrow();
      expect(narrated).toBe(2);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  30000,
);
