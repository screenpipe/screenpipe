// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
// Standalone browser test of the real shared component. CLOUD_UI_RUNTIME points
// to a package.json with esbuild and @playwright/test when absent in this app.
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const require = createRequire(process.env.CLOUD_UI_RUNTIME || new URL("../../package.json", import.meta.url));
const { build } = require("esbuild");
const { chromium } = require("@playwright/test");
const app = new URL("../../", import.meta.url).pathname;
const temp = mkdtempSync(join(tmpdir(), "cloud-access-ui-"));
await build({ stdin: { contents: `import React from 'react'; import {createRoot} from 'react-dom/client'; import {CloudConnectionAccess} from '${app}components/settings/cloud-connection-access.tsx'; createRoot(document.getElementById('root')).render(<CloudConnectionAccess/>);`, loader: "tsx", resolveDir: app }, bundle: true, jsx: "automatic", outfile: join(temp, "app.js"), plugins: [{ name: "native-fixtures", setup(b) {
  b.onResolve({ filter: /^@\/lib\// }, args => ({ path: args.path, namespace: "fixture" }));
  b.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: `export const localFetch=(path,init)=>fetch('/local'+path,init); export const useSettings=()=>({settings:{user:{token:'fixture-session'}}}); export const screenpipeWebUrl=path=>'https://screenpipe.test'+path; export const notifyConnectionsUpdated=()=>{}; export const CONNECTIONS_UPDATED_EVENT="connections-updated";`, loader: "js" }));
} }] });
const html = '<!doctype html><html><head><meta name="viewport" content="width=device-width"><style>body{font:14px system-ui;background:#f6f6f3;color:#0a0a0a;max-width:800px;margin:40px auto;padding:20px}details{border:1px solid #ccc;padding:20px}p,select,button,label{margin:12px 0}select,button{padding:8px;max-width:100%}label{display:block}button:disabled{opacity:.4}</style></head><body><h1>Connections</h1><div id="root"></div><script src="/app.js"></script></body></html>';
const server = createServer((req, res) => { res.setHeader("Content-Type", req.url === "/app.js" ? "text/javascript" : "text/html"); res.end(req.url === "/app.js" ? readFileSync(join(temp, "app.js")) : html); });
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
let browser;
try {
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1080, height: 800 } });
  const errors = []; page.on("pageerror", error => errors.push(error.message));
  await page.route("**/api/enterprise/cloud-connections/workspaces", route => route.fulfill({ json: { workspaces: [{ id: "aaaaaaaa-0000-4000-8000-000000000001", org_name: "Example workspace" }] } }));
  await page.route("**/local/connections/cloud", route => route.fulfill({ json: { storage:"cloud", cloud_available:true, connections: [
    { key: "slack:work", name: "Slack", instance: "work", cloud_available: true },
    { key: "stripe", name: "Stripe", cloud_available: true },
    { key: "mcp:research", name: "Research MCP", cloud_available: true },
    { key: "obsidian", name: "Obsidian", cloud_available: false },
  ] } }));
  let moves = 0;
  await page.route("**/local/connections/cloud/share", async route => {
    const body = route.request().postDataJSON();
    if (body.key !== "mcp:research" || body.allow_cloud !== true || Object.hasOwn(body,"token")) throw new Error("wrong move request");
    if (Object.keys(body).some(key => /credential|refresh|secret/.test(key))) throw new Error("credentials crossed the webview");
    moves++; await route.fulfill({ json: { moved: true, local_cleanup_required: false, account_id: "aaaaaaaa-0000-4000-8000-000000000002" } });
  });
  await page.goto("http://127.0.0.1:" + server.address().port);
  if (moves) throw new Error("mount migrated existing credentials");
  if (await page.getByLabel("Storage for new connections").inputValue() !== "cloud") throw new Error("cloud not default");
  if (await page.getByLabel("Cloud workspace").count()) throw new Error("workspace picker still present");
  await page.getByRole("button",{name:"Use existing connections in the cloud"}).click();
  if (await page.getByLabel("Obsidian").count()) throw new Error("local-only integration offered for migration");
  const consent = page.getByLabel("Move the selected credentials to cloud storage.",{exact:false});
  await page.getByLabel("Slack (work)",{exact:true}).check();
  if (await page.getByRole("button",{name:"Enable cloud access"}).isEnabled()) throw new Error("consent missing");
  await consent.check();
  await page.getByLabel("Slack (work)",{exact:true}).uncheck();
  await page.getByLabel("Research MCP",{exact:true}).check();
  if (await consent.isChecked()) throw new Error("consent reused");
  const screenshots = process.env.CLOUD_CONNECTION_SCREENSHOTS || join(temp,"screenshots"); mkdirSync(screenshots,{recursive:true});
  await page.screenshot({path:join(screenshots,"desktop-cloud-access.png"),fullPage:true});
  await consent.check();
  await page.getByRole("button",{name:"Enable cloud access"}).click();
  await page.getByRole("status").filter({hasText:"Connections are ready"}).waitFor();
  if (moves !== 1) throw new Error("unexpected moves");
  let changes = 0;
  await page.route("**/local/connections/cloud/settings",async route => {
    if (route.request().postDataJSON().storage !== "local") throw new Error("wrong preference");
    changes++; await route.fulfill({json:{storage:"local"}});
  });
  await page.getByLabel("Storage for new connections").selectOption("local");
  await page.getByText("New connections stay on this device.",{exact:true}).waitFor();
  if(changes !== 1 || moves !== 1) throw new Error("preference change moved credentials");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(screenshots, "desktop-cloud-access-mobile.png"), fullPage: true });
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error("horizontal overflow");
  if (errors.length) throw new Error(errors.join("\n"));
  console.log("PASS: shared native component, OAuth/API-key/MCP inventory, local-only gating, explicit move consent, no provider credential in webview payload, mobile layout");
} finally { await browser?.close(); server.close(); rmSync(temp, { recursive: true, force: true }); }
