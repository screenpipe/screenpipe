/**
 * @screenpipe/browser — Browser SDK for Screenpipe
 *
 * Re-exports the core ScreenpipeClient and all types.
 * In the browser you can simply:
 *
 *   import { ScreenpipeClient } from "@screenpipe/browser";
 *   const client = new ScreenpipeClient();
 *   const results = await client.search({ contentType: "ocr", limit: 10 });
 */

export { ScreenpipeClient } from "../../common/client";
export type { ScreenpipeClientConfig } from "../../common/client";
export * from "../../common/types";
