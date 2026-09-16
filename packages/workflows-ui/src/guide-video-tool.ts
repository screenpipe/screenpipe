// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { mkdir, readFile, writeFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";

export type VideoScene = {
  title: string;
  narration: string;
  image: string | null;
};
export function parseVideoScenes(value: unknown): VideoScene[] {
  if (!Array.isArray(value) || !value.length || value.length > 12)
    throw new Error("Choose 1–12 scenes for a short video.");
  return value.map((s) => {
    if (
      !s ||
      typeof s.title !== "string" ||
      s.title.length > 120 ||
      typeof s.narration !== "string" ||
      !s.narration.trim() ||
      [...s.narration].length > 800 ||
      (s.image !== null &&
        (typeof s.image !== "string" ||
          s.image.length > 12_000_000 ||
          !/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(
            s.image,
          )))
    )
      throw new Error("A video scene is incomplete or too long.");
    return { title: s.title, narration: s.narration, image: s.image };
  });
}
const escapeAss = (text: string) =>
  text.replace(/\\/g, "/").replace(/[{}]/g, "").replace(/\r?\n/g, "\\N");
export function sceneCaptions(scene: VideoScene, duration = 10) {
  const words = scene.narration.trim().split(/\s+/);
  const stamp = (seconds: number) => {
    const ticks = Math.round(seconds * 100);
    return `${Math.floor(ticks / 360000)}:${String(Math.floor(ticks / 6000) % 60).padStart(2, "0")}:${String(Math.floor(ticks / 100) % 60).padStart(2, "0")}.${String(ticks % 100).padStart(2, "0")}`;
  };
  const captions = [];
  for (let i = 0; i < words.length; i += 12)
    captions.push(
      `Dialogue: 0,${stamp((duration * i) / words.length)},${stamp((duration * Math.min(i + 12, words.length)) / words.length)},Caption,,0,0,0,,${escapeAss(words.slice(i, i + 12).join(" "))}`,
    );
  // The same reviewed text drives voice and captions. ASS handles wrapping.
  return `[Script Info]\nPlayResX: 1280\nPlayResY: 720\nWrapStyle: 0\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Title,Arial,28,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,-1,0,0,0,100,100,0,0,1,1,0,8,48,48,20,1\nStyle: Caption,Arial,22,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,2,48,48,22,1\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:00.00,0:10:00.00,Title,,0,0,0,,${escapeAss(scene.title)}\n${captions.join("\n")}\n`;
}
async function command(
  binary: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary, args, {
      cwd,
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    // Never return raw FFmpeg stderr, which can contain local paths.
    child.stderr?.resume();
    const stop = () => child.kill("SIGKILL");
    const timer = setTimeout(stop, 120000);
    const exit = () => stop();
    process.once("exit", exit);
    signal.addEventListener("abort", stop, { once: true });
    child.once("error", () =>
      finish(
        new Error("FFmpeg could not start. Update Screenpipe and try again."),
      ),
    );
    child.once("close", (code) =>
      finish(
        code === 0
          ? undefined
          : new Error(
              signal.aborted
                ? "Stopped"
                : "Video rendering failed. Your guide is saved.",
            ),
      ),
    );
    function finish(error?: Error) {
      clearTimeout(timer);
      process.removeListener("exit", exit);
      signal.removeEventListener("abort", stop);
      error ? reject(error) : resolve();
    }
  });
}
export async function renderGuideVideo(options: {
  root: string;
  jobId: string;
  ffmpeg: string;
  signal: AbortSignal;
  narrate: (text: string, signal: AbortSignal) => Promise<Uint8Array>;
  progress?: (message: string) => void;
}) {
  if (!/^[a-f0-9-]{36}$/.test(options.jobId))
    throw new Error("Invalid video job.");
  const dir = join(options.root, options.jobId);
  if ((await stat(join(dir, "scenes.json"))).size > 64_000_000)
    throw new Error("Video draft is too large.");
  const scenes = parseVideoScenes(
    JSON.parse(await readFile(join(dir, "scenes.json"), "utf8")),
  );
  await mkdir(dir, { recursive: true });
  const common = ["-hide_banner", "-loglevel", "error", "-y", "-threads", "2"];
  for (const [i, scene] of scenes.entries()) {
    options.signal.throwIfAborted();
    options.progress?.(`Recording narration ${i + 1} of ${scenes.length}`);
    const audio = await options.narrate(scene.narration, options.signal);
    if (!audio.length || audio.length > 8_000_000)
      throw new Error("Narration audio was incomplete.");
    await writeFile(join(dir, `${i}.mp3`), audio);
    const probe = await promisify(execFile)(
      options.ffmpeg,
      ["-hide_banner", "-f", "mp3", "-i", `${i}.mp3`, "-f", "null", "-"],
      { cwd: dir, signal: options.signal, timeout: 15000, maxBuffer: 64000 },
    ).catch(() => {
      throw new Error("Narration audio could not be read.");
    });
    const match = probe.stderr.match(/Duration: (\d+):(\d+):(\d+\.\d+)/);
    if (!match) throw new Error("Narration duration could not be read.");
    const duration =
      Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
    if (!(duration > 0 && duration <= 180))
      throw new Error("Narration is too long for a scene.");
    await writeFile(join(dir, `${i}.ass`), sceneCaptions(scene, duration));
    const codec = scene.image?.startsWith("data:image/png")
      ? "png"
      : scene.image?.startsWith("data:image/jpeg")
        ? "mjpeg"
        : "webp";
    const input = scene.image
      ? [
          "-protocol_whitelist",
          "file,pipe",
          "-f",
          "image2",
          "-pattern_type",
          "none",
          "-c:v",
          codec,
          "-loop",
          "1",
          "-i",
          `${i}.image`,
        ]
      : ["-f", "lavfi", "-i", "color=c=0x20221d:s=1280x520:r=24"];
    if (scene.image)
      await writeFile(
        join(dir, `${i}.image`),
        Buffer.from(scene.image.split(",")[1], "base64"),
      );
    options.progress?.(`Rendering scene ${i + 1} of ${scenes.length}`);
    await command(
      options.ffmpeg,
      [
        ...common,
        ...input,
        "-f",
        "mp3",
        "-i",
        `${i}.mp3`,
        "-vf",
        `scale=1280:480:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:70:color=0x20221d,subtitles=${i}.ass`,
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-pix_fmt",
        "yuv420p",
        "-r",
        "24",
        "-c:a",
        "aac",
        "-b:a",
        "128k",
        "-shortest",
        "-t",
        "180",
        `${i}.mp4`,
      ],
      dir,
      options.signal,
    );
  }
  options.progress?.("Finishing your video");
  await writeFile(
    join(dir, "concat.txt"),
    scenes.map((_, i) => `file '${i}.mp4'`).join("\n"),
  );
  await command(
    options.ffmpeg,
    [
      ...common,
      "-f",
      "concat",
      "-safe",
      "1",
      "-i",
      "concat.txt",
      "-c",
      "copy",
      "-movflags",
      "+faststart",
      "rendering.mp4",
    ],
    dir,
    options.signal,
  );
  options.signal.throwIfAborted();
  await rename(join(dir, "rendering.mp4"), join(dir, "guide.mp4"));
  // Intermediate images/audio are private and no longer needed after success.
  for (const [i] of scenes.entries())
    for (const ext of ["mp3", "ass", "image", "mp4"])
      await rm(join(dir, `${i}.${ext}`), { force: true });
  return { jobId: options.jobId, filename: "guide.mp4", scenes: scenes.length };
}
export default function guideVideoTool(pi: any) {
  pi.registerTool({
    name: "render_guide_video",
    label: "Render guide video",
    description:
      "Render the user-reviewed local guide scenes as a narrated MP4. Uses Screenpipe account narration and local FFmpeg. Never uploads screenshots or publishes. Call once with the supplied jobId; return its receipt unchanged.",
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["jobId"],
      properties: { jobId: { type: "string", pattern: "^[a-f0-9-]{36}$" } },
    },
    async execute(
      _id: string,
      args: { jobId: string },
      signal: AbortSignal,
      onUpdate: any,
    ) {
      if (!process.env.SCREENPIPE_API_KEY)
        throw new Error("Sign in to Screenpipe to create narration.");
      if (!process.env.SCREENPIPE_FFMPEG_PATH)
        throw new Error(
          "FFmpeg is unavailable. Update Screenpipe and try again.",
        );
      const result = await renderGuideVideo({
        root: join(process.cwd(), "guide-media"),
        jobId: args.jobId,
        ffmpeg: process.env.SCREENPIPE_FFMPEG_PATH,
        signal,
        progress: (message) =>
          onUpdate?.({ content: [{ type: "text", text: message }] }),
        async narrate(text, signal) {
          const response = await fetch(
            "https://api.screenpi.pe/v1/guide-narration",
            {
              method: "POST",
              headers: {
                Authorization: `Bearer ${process.env.SCREENPIPE_API_KEY}`,
                "Content-Type": "application/json",
              },
              body: JSON.stringify({ text }),
              signal,
              redirect: "error",
            },
          );
          if (!response.ok)
            throw new Error(
              response.status === 403
                ? "Guide narration requires Business."
                : response.status === 429
                  ? "Narration allowance reached. Try again later."
                  : response.status === 503
                    ? "Guide narration is not available yet. Your guide is saved."
                    : "Narration failed. Your guide is saved.",
            );
          if (!response.headers.get("content-type")?.startsWith("audio/"))
            throw new Error("Narration audio was incomplete.");
          return new Uint8Array(await response.arrayBuffer());
        },
      });
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  });
}
