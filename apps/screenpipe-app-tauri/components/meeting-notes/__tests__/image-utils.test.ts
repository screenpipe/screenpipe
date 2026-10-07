// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { afterEach, describe, expect, it, vi } from "vitest";
import { resizeImageDataUrl } from "../image-utils";

// jsdom decodes no images, so the browser's Image and canvas are stood in for:
// an image "decodes" to the size given for its data URL, or fails without one.
const sizes = new Map<string, { width: number; height: number }>();
const drawn: string[] = [];

class FakeImage {
  width = 0;
  height = 0;
  onload: (() => void) | null = null;
  onerror: (() => void) | null = null;
  set src(value: string) {
    const size = sizes.get(value);
    queueMicrotask(() => {
      if (!size) return this.onerror?.();
      Object.assign(this, size);
      this.onload?.();
    });
  }
}

function fakeCanvas() {
  const canvas = { width: 0, height: 0 } as HTMLCanvasElement;
  const ctx = {
    set fillStyle(color: string) {
      drawn.push(`fill ${color}`);
    },
    fillRect: () => drawn.push("fillRect"),
    drawImage: () => drawn.push(`draw ${canvas.width}x${canvas.height}`),
  };
  canvas.getContext = (() => ctx) as unknown as HTMLCanvasElement["getContext"];
  canvas.toDataURL = (type?: string) => `data:${type};base64,REENCODED`;
  return canvas;
}

function image(type: string, length: number, size?: { width: number; height: number }) {
  const prefix = `data:${type};base64,`;
  const dataUrl = prefix + "A".repeat(length - prefix.length);
  if (size) sizes.set(dataUrl, size);
  return dataUrl;
}

describe("resizeImageDataUrl", () => {
  vi.stubGlobal("Image", FakeImage);
  const createElement = document.createElement.bind(document);
  vi.spyOn(document, "createElement").mockImplementation((tag: string) =>
    tag === "canvas" ? fakeCanvas() : createElement(tag),
  );

  afterEach(() => {
    sizes.clear();
    drawn.length = 0;
  });

  it("keeps a small image that fits as it came, with its transparency and animation", async () => {
    for (const type of ["image/png", "image/gif", "image/webp"]) {
      const original = image(type, 40_000, { width: 300, height: 200 });
      await expect(resizeImageDataUrl(original)).resolves.toBe(original);
    }
    expect(drawn).toEqual([]);
  });

  it("re-encodes a large image onto white, never onto black", async () => {
    const result = await resizeImageDataUrl(image("image/png", 900_000, { width: 800, height: 600 }));
    expect(result).toBe("data:image/jpeg;base64,REENCODED");
    expect(drawn).toEqual(["fill #fff", "fillRect", "draw 800x600"]);
  });

  it("scales an image wider than the note allows", async () => {
    await resizeImageDataUrl(image("image/png", 40_000, { width: 4096, height: 1024 }));
    expect(drawn.at(-1)).toBe("draw 1024x256");
  });

  it("keeps a small SVG at any size, and re-encodes a large one", async () => {
    const small = image("image/svg+xml", 40_000, { width: 5000, height: 5000 });
    await expect(resizeImageDataUrl(small)).resolves.toBe(small);
    const large = image("image/svg+xml", 900_000, { width: 500, height: 500 });
    await expect(resizeImageDataUrl(large)).resolves.toBe("data:image/jpeg;base64,REENCODED");
  });

  it("returns null for an image that can't be decoded, of any size", async () => {
    await expect(resizeImageDataUrl(image("image/png", 40_000))).resolves.toBeNull();
    await expect(resizeImageDataUrl(image("image/svg+xml", 40_000))).resolves.toBeNull();
    await expect(resizeImageDataUrl(image("image/png", 900_000))).resolves.toBeNull();
  });

  it("returns null for a large image with no size to scale from", async () => {
    await expect(
      resizeImageDataUrl(image("image/svg+xml", 900_000, { width: 0, height: 0 })),
    ).resolves.toBeNull();
  });
});
