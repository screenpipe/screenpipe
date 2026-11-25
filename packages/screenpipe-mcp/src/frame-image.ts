// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

export type JpegImage = { type: "image"; data: string; mimeType: "image/jpeg" };

export async function jpegImageContent(response: Response, tool: string, maxBytes: number): Promise<JpegImage> {
  const mimeType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mimeType !== "image/jpeg") {
    throw new Error(`${tool} returned unsupported content type '${mimeType || "missing"}'`);
  }

  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new Error(`${tool} image exceeds ${maxBytes} bytes`);
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength === 0) {
    throw new Error(`${tool} returned an empty image`);
  }
  if (bytes.byteLength > maxBytes) {
    throw new Error(`${tool} image exceeds ${maxBytes} bytes`);
  }
  if (bytes.byteLength < 3 || bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
    throw new Error(`${tool} returned invalid JPEG bytes`);
  }

  return { type: "image", data: Buffer.from(bytes).toString("base64"), mimeType: "image/jpeg" };
}
