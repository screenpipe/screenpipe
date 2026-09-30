// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { importContextFiles } from "./context-import";
self.onmessage = async (event: MessageEvent<File[]>) => {
  try { self.postMessage({ result: await importContextFiles(event.data) }); }
  catch (error) { self.postMessage({ error: error instanceof Error ? error.message : "Could not read these files." }); }
};
