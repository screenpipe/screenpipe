// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const MAX_FRAME_IMAGE_BYTES = 1_000_000;

function apiBase(): string {
  const url =
    process.env.SCREENPIPE_LOCAL_API_URL ||
    `http://localhost:${process.env.SCREENPIPE_PORT || "3030"}`;
  return url.replace(/\/+$/, "");
}

function authHeaders(): Record<string, string> {
  const key =
    process.env.SCREENPIPE_LOCAL_API_KEY ||
    process.env.SCREENPIPE_API_AUTH_KEY ||
    "";
  const sessionId = process.env.SCREENPIPE_SESSION_ID || "";
  return {
    ...(key ? { Authorization: `Bearer ${key}` } : {}),
    ...(sessionId ? { "x-screenpipe-session": sessionId } : {}),
  };
}

function clampInt(raw: unknown, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.trunc(n)));
}

async function readBoundedBytes(
  res: Response,
  maxBytes: number,
): Promise<{ tooLarge: true; bytes: number } | { tooLarge: false; buffer: Buffer }> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    try {
      await res.body?.cancel();
    } catch {}
    return { tooLarge: true, bytes: declared };
  }
  if (!res.body || typeof res.body.getReader !== "function") {
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > maxBytes ? { tooLarge: true, bytes: buf.length } : { tooLarge: false, buffer: buf };
  }
  const reader = res.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      try {
        await reader.cancel();
      } catch {}
      return { tooLarge: true, bytes: total };
    }
    chunks.push(Buffer.from(value));
  }
  return { tooLarge: false, buffer: Buffer.concat(chunks, total) };
}

const frameImageParams = {
  type: "object",
  properties: {
    frame_id: {
      type: "integer",
      minimum: 1,
      description: "Frame ID from /search (content.frame_id) or frames.id.",
    },
    width: {
      type: "integer",
      minimum: 64,
      maximum: 1920,
      description: "Maximum output width in pixels (default 1280; aspect ratio preserved).",
    },
    quality: {
      type: "integer",
      minimum: 20,
      maximum: 95,
      description: "JPEG quality 20-95 (default 75).",
    },
  },
  required: ["frame_id"],
  additionalProperties: false,
} as any;

export default function (pi: ExtensionAPI) {
  pi.registerTool({
    name: "frame_image",
    label: "Frame screenshot",
    description:
      "Fetch the captured screenshot image for a specific frame_id (from /search or frames.id) so you can inspect visual layout, charts, diagrams, media, canvas/video UI, or moments where text capture is incomplete. Fetch at most 2-3 frames per turn. Respects local history-access and image-privacy release gates.",
    parameters: frameImageParams,

    async execute(
      _toolCallId: string,
      params: { frame_id: number; width?: number; quality?: number },
      signal: AbortSignal,
    ) {
      const id = Number(params?.frame_id);
      if (!Number.isSafeInteger(id) || id <= 0) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: "frame_id must be a positive integer" }) }],
          isError: true,
        };
      }
      const width = clampInt(params?.width, 1280, 64, 1920);
      const quality = clampInt(params?.quality, 75, 20, 95);
      const path = `/frames/${id}/thumbnail?width=${width}&quality=${quality}&fallback=false`;

      try {
        const res = await fetch(`${apiBase()}${path}`, {
          method: "GET",
          headers: authHeaders(),
          signal,
        });
        if (!res.ok) {
          const detail = (await res.text().catch(() => "")).slice(0, 1000);
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ error: `${path} returned ${res.status}`, status: res.status, detail }),
              },
            ],
            isError: true,
          };
        }
        const rawType = (res.headers.get("content-type") || "image/jpeg").split(";")[0].trim().toLowerCase();
        const mimeType = rawType.startsWith("image/") ? rawType : "image/jpeg";
        const bounded = await readBoundedBytes(res, MAX_FRAME_IMAGE_BYTES);
        if (bounded.tooLarge) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: `frame_image payload (${bounded.bytes} bytes) exceeds ${MAX_FRAME_IMAGE_BYTES} byte limit; lower width or quality`,
                  frame_id: id,
                }),
              },
            ],
            isError: true,
          };
        }
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ frame_id: id, mime_type: mimeType, bytes: bounded.buffer.length, width, quality }),
            },
            {
              type: "image" as const,
              mimeType,
              data: bounded.buffer.toString("base64"),
            },
          ],
        };
      } catch (e: any) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: `frame_image failed: ${e?.message ?? String(e)}`, frame_id: id }),
            },
          ],
          isError: true,
        };
      }
    },
  });
}
