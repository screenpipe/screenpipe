// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { runInNewContext } from "node:vm";

// Execute complete historical component modules. React hooks/host elements,
// settings IO and unrelated UI/native ports are synthetic; no desktop is run.
const app = resolve("apps/screenpipe-app-tauri");
const realPaths = [
  "components/settings/privacy-section.tsx",
  "components/settings/capture-filters/content-filters-card.tsx",
  "components/settings/capture-filters/category-switches.tsx",
  "lib/settings/capture-categories.ts",
  "lib/settings/capture-filters.ts",
];
const built = new Map();
for (const path of realPaths) {
  const filename = resolve(app, path);
  if (!existsSync(filename)) throw new Error(`Cannot find module '${filename}'`);
  const result = await Bun.build({ entrypoints: [filename], external: ["*"], target: "node", format: "cjs", write: false });
  if (!result.success) throw new Error(`Cannot compile privacy source: ${result.logs.join("\n")}`);
  built.set(filename, await result.outputs[0].text());
}

function environment(initial = {}) {
  let settings = { ignoredWindows: [], includedWindows: [], ignoredUrls: [], ...structuredClone(initial) };
  const writes = [];
  const cache = new Map();
  const element = (type, props, ...children) => ({ type, props: { ...props, ...(children.length ? { children } : {}) } });
  const react = {
    createElement: element, Fragment: "fragment",
    useState: initial => [typeof initial === "function" ? initial() : initial, () => {}],
    useRef: value => ({ current: value }), useMemo: fn => fn(), useCallback: fn => fn,
    // Effects load native/telemetry state unrelated to category changes.
    useEffect: () => {},
  };
  const host = new Proxy({}, { get: (_, name) => name === "__esModule" ? true : String(name) });
  const forbidden = () => { throw new Error("Unexpected native/provider side effect"); };
  function port(id, from) {
    const path = id.startsWith("@/") ? resolve(app, id.slice(2)) : id.startsWith(".") ? resolve(dirname(from), id) : id;
    for (const suffix of ["", ".ts", ".tsx"]) if (built.has(path + suffix)) return load(path + suffix);
    if (id === "react") return { ...react, default: react };
    if (id === "react/jsx-runtime" || id === "react/jsx-dev-runtime") return { jsx: (type, props) => element(type, props), jsxs: (type, props) => element(type, props), jsxDEV: (type, props) => element(type, props), Fragment: "fragment" };
    if (id === "@/lib/hooks/use-settings") return { useSettings: () => ({ settings, updateSettings: async patch => {
      writes.push(structuredClone(patch)); settings = { ...settings, ...structuredClone(patch) };
    } }) };
    if (id === "@/lib/hooks/use-managed-policy") return { useManagedPolicy: () => ({ getManagedValue: () => undefined, isManagedDeployment: false }) };
    if (id === "@/components/ui/use-toast") return { useToast: () => ({ toast: forbidden }) };
    if (id === "@/lib/hooks/use-sql-autocomplete") return { useSqlAutocomplete: () => ({ items: [], isLoading: false }) };
    if (id === "@/lib/hooks/use-installed-apps") return { useInstalledApps: () => ({ apps: [] }) };
    if (id === "@/lib/utils/validation") return { sanitizeValue: (_, value) => value, validateField: () => ({ isValid: true }), debounce: fn => fn };
    if (id === "@/lib/utils") return { cn: (...parts) => parts.filter(Boolean).join(" ") };
    if (id === "@/lib/web-url") return { screenpipeWebUrl: () => "https://example.invalid" };
    if (id === "./icon-urls") return { appIconUrl: () => "" };
    if (id === "@tauri-apps/plugin-os") return { platform: () => "linux" };
    if (id === "@/lib/utils/tauri") return { commands: new Proxy({}, { get: () => forbidden }) };
    if (id === "posthog-js") return { default: new Proxy({}, { get: () => forbidden }) };
    if (["@sentry/react", "tauri-plugin-sentry-api", "@tauri-apps/plugin-shell", "@/lib/utils/incognito-permission", "@/lib/analytics-id"].includes(id)) return new Proxy({}, { get: () => forbidden });
    // Only visual leaves outside the ownership path are opaque host elements.
    if (id === "lucide-react" || id.startsWith("@/components/") || (id.startsWith(".") && from.includes("/components/"))) return host;
    throw new Error(`Cannot find module '${id}' in synthetic privacy adapter`);
  }
  function load(filename) {
    if (cache.has(filename)) return cache.get(filename).exports;
    const module = { exports: {} }; cache.set(filename, module);
    runInNewContext(built.get(filename), { module, exports: module.exports, require: id => port(id, filename), console, process: { env: {} } }, { filename });
    return module.exports;
  }
  const { PrivacySection } = load(resolve(app, realPaths[0]));
  const categories = load(resolve(app, realPaths[3])).CAPTURE_CATEGORIES;
  function expand(node) {
    if (!node || typeof node !== "object") return node;
    if (Array.isArray(node)) return node.map(expand);
    if (typeof node.type === "function") {
      return expand(node.type(node.props));
    }
    return { ...node, props: { ...node.props, children: expand(node.props?.children) } };
  }
  function find(node, predicate) {
    if (!node || typeof node !== "object") return undefined;
    if (Array.isArray(node)) return node.map(n => find(n, predicate)).find(Boolean);
    return predicate(node) ? node : find(node.props?.children, predicate);
  }
  return {
    categories, writes, settings: () => structuredClone(settings),
    async toggle(id, enabled) {
      const tree = expand(PrivacySection());
      const row = find(tree, n => n.props?.["data-category"] === id);
      expect(row, `category ${id} renders`).toBeDefined();
      const control = find(row, n => typeof n.props?.onCheckedChange === "function");
      expect(control, "category switch has an event handler").toBeDefined();
      const count = writes.length; await control.props.onCheckedChange(enabled);
      // The real settings callback serializes writes through a Promise chain.
      await new Promise(resolve => setTimeout(resolve, 0));
      expect(writes.length).toBeGreaterThan(count);
      // Discard all component state between interactions, like reopening settings.
    },
  };
}

// Freeze task inputs independently of candidate category definitions.
const definitions = [
  {
    "id": "password-managers",
    "apps": [
      "1Password::",
      "Bitwarden::",
      "LastPass::",
      "Dashlane::",
      "KeePassXC::",
      "KeePass::",
      "NordPass::",
      "Enpass::",
      "Proton Pass::",
      "Keychain Access::",
      "Credential Manager::"
    ],
    "domains": [
      "1password.com",
      "bitwarden.com",
      "lastpass.com",
      "dashlane.com",
      "keepersecurity.com",
      "nordpass.com",
      "pass.proton.me"
    ]
  },
  {
    "id": "personal-messaging",
    "apps": [
      "WhatsApp::",
      "Signal::",
      "Telegram::",
      "Messages::",
      "Messenger::"
    ],
    "domains": [
      "web.whatsapp.com",
      "web.telegram.org",
      "messenger.com"
    ]
  },
  {
    "id": "banking-finance",
    "apps": [],
    "domains": [
      "chase.com",
      "bankofamerica.com",
      "wellsfargo.com",
      "citi.com",
      "capitalone.com",
      "schwab.com",
      "fidelity.com",
      "vanguard.com",
      "paypal.com",
      "wise.com",
      "revolut.com",
      "coinbase.com"
    ]
  },
  {
    "id": "health",
    "apps": [],
    "domains": [
      "mychart.com",
      "healthcare.gov",
      "cvs.com",
      "walgreens.com",
      "zocdoc.com"
    ]
  },
  {
    "id": "media",
    "apps": [
      "Netflix::",
      "Spotify::",
      "Steam::"
    ],
    "domains": [
      "netflix.com",
      "hulu.com",
      "disneyplus.com",
      "max.com",
      "twitch.tv",
      "open.spotify.com"
    ]
  }
];
for (const category of definitions) {
  if (category.domains.length) test(`${category.id}: preserve manually supplied domains across enable, persisted reload and disable`, async () => {
    const manual = category.domains[0]; if (!manual) return;
    const env = environment({ ignoredUrls: [manual, "manual.example.invalid"] });
    await env.toggle(category.id, true);
    for (const domain of category.domains) expect(env.settings().ignoredUrls).toContain(domain);
    await env.toggle(category.id, false);
    expect(env.settings().ignoredUrls.sort()).toEqual([manual, "manual.example.invalid"].sort());
    expect(env.settings().ignoredWindows).toEqual([]);
  });
  if (category.apps.length) test(`${category.id}: preserve manually supplied scoped app exclusion`, async () => {
    const manual = category.apps[0]; if (!manual) return;
    const env = environment({ ignoredWindows: [manual, "Handwritten::private"] });
    await env.toggle(category.id, true); await env.toggle(category.id, false);
    expect(env.settings().ignoredWindows.sort()).toEqual([manual, "Handwritten::private"].sort());
    expect(env.settings().ignoredUrls).toEqual([]);
  });
  test(`${category.id}: clean up created filters and tolerate repeated off`, async () => {
    const env = environment(); await env.toggle(category.id, true);
    for (const app of category.apps) expect(env.settings().ignoredWindows).toContain(app);
    for (const domain of category.domains) expect(env.settings().ignoredUrls).toContain(domain);
    await env.toggle(category.id, false); await env.toggle(category.id, false);
    expect(env.settings().ignoredWindows).toEqual([]); expect(env.settings().ignoredUrls).toEqual([]);
  });
}
test("turning one category off preserves another category and unrelated include rules", async () => {
  const [first, second] = definitions; const env = environment({ includedWindows: ["Work::meeting"] });
  await env.toggle(first.id, true); await env.toggle(second.id, true); await env.toggle(first.id, false);
  for (const app of second.apps) expect(env.settings().ignoredWindows).toContain(app);
  for (const domain of second.domains) expect(env.settings().ignoredUrls).toContain(domain);
  expect(env.settings().includedWindows).toEqual(["Work::meeting"]);
  await env.toggle(second.id, false);
  expect(env.settings().ignoredWindows).toEqual([]); expect(env.settings().ignoredUrls).toEqual([]);
});
test("legacy enabled category without provenance can still be disabled", async () => {
  const first = definitions[0]; const env = environment({ ignoredWindows: [...first.apps, "Manual::private"], ignoredUrls: [...first.domains, "manual.example.invalid"] });
  await env.toggle(first.id, false);
  expect(env.settings().ignoredWindows).toEqual(["Manual::private"]);
  expect(env.settings().ignoredUrls).toEqual(["manual.example.invalid"]);
});
