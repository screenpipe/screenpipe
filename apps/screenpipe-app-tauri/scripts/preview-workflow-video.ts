// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
// Local, synthetic product-component preview. Does not call native commands or providers.
import { createServer } from "vite";
import { createReadStream, existsSync } from "node:fs";
import { resolve } from "node:path";
const app = resolve(import.meta.dir, "..");
const video = process.argv[2] && resolve(process.argv[2]);
const server = await createServer({
  root: app, configFile: resolve(app, "vitest.config.ts"),
  resolve: { alias: {
    ...Object.fromEntries(["react", "react-dom", "react-markdown", "remark-gfm", "unpdf", "fflate"].map(name => [name, resolve(app, "node_modules", name)])),
    "@screenpipe/workflows-ui/fixture": resolve(app, "../../packages/workflows-ui/src/fixture-platform.ts"),
    "@screenpipe/workflows-ui": resolve(app, "../../packages/workflows-ui/src/index.ts"),
  } },
  server: { host: "127.0.0.1", port: 1455, strictPort: true },
  plugins: [{ name: "video-sop-preview", configureServer(server) {
    server.middlewares.use(async (request, response, next) => {
      if (request.url?.startsWith("/video-eval.html")) {
        response.setHeader("Content-Type", "text/html");
        response.end(await server.transformIndexHtml(request.url,
          '<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><title>Video SOP component preview</title><style>body{margin:0}*{box-sizing:border-box}</style></head><body><div id="root"></div><script type="module" src="/e2e/fixtures/workflow-video-preview.tsx"></script></body></html>'));
      } else if (request.url === "/synthetic-video.mp4" && video && existsSync(video)) {
        response.setHeader("Content-Type", "video/mp4");
        createReadStream(video).pipe(response);
      } else next();
    });
  } }],
});
await server.listen();
console.log("http://127.0.0.1:1455/video-eval.html?state=review");
