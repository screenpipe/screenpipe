// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import React, { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { initializeGT, T, useGT, useMessages, msg } from "gt-react";
import { OfflineGTProvider as GTProvider } from "./offline-provider";
import { localizeDefinitions } from "./definitions";
import { hashMessage } from "gt-i18n/internal";

afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

test("a cookieless Tauri origin changes bundled JSX and messages without losing drafts or fetching", async () => {
  // WKWebView's tauri://localhost origin does not persist document.cookie.
  vi.spyOn(document, "cookie", "get").mockReturnValue("");
  vi.spyOn(document, "cookie", "set").mockImplementation(() => {});
  const fetch = vi.fn(() => { throw new Error("Runtime localization must stay offline"); });
  vi.stubGlobal("fetch", fetch);
  const source = "Hello {name}";
  const translations = { ja: {
    [hashMessage("Settings", { $format: "JSX" })]: "設定",
    [hashMessage(source, { $format: "ICU" })]: "こんにちは、{name}さん",
  } };
  initializeGT({ defaultLocale: "en", locales: ["ja"], loadTranslations: async (locale) => translations[locale as "ja"] ?? {}, runtimeUrl: null, _disableDevHotReload: true });
  function Example() {
    const gt = useGT();
    const [draft, setDraft] = useState("");
    return <><T>Settings</T><p>{gt("Hello {name}", { name: "Alice" })}</p><input aria-label="Draft" value={draft} onChange={(e) => setDraft(e.target.value)} /></>;
  }
  const MemoExample = React.memo(Example);
  const view = render(<GTProvider locale="en" translations={translations}><MemoExample /></GTProvider>);
  fireEvent.change(screen.getByRole("textbox", { name: "Draft" }), { target: { value: "private draft" } });
  expect(screen.getByText("Hello Alice")).toBeVisible();
  view.rerender(<GTProvider locale="ja" translations={translations}><MemoExample /></GTProvider>);
  expect(await screen.findByText("設定")).toBeVisible();
  expect(screen.getByText("こんにちは、Aliceさん")).toBeVisible();
  expect(screen.getByRole("textbox", { name: "Draft" })).toHaveValue("private draft");
  expect(fetch).not.toHaveBeenCalled();
});


test("compiled shared definitions resolve on a language switch without exposing markers or translating values", async () => {
  const label = "Recording";
  const id = hashMessage(label, { $format: "ICU" });
  const definitions = [{id: "recording", label: msg(label, {}), prompt: "Recording"}];
  const translations = { ja: {[id]: "録画中"} };
  initializeGT({defaultLocale: "en", locales: ["ja"], loadTranslations: async () => translations.ja, runtimeUrl: null, _disableDevHotReload: true});
  function Options() {
    const message = useMessages();
    const [item] = localizeDefinitions(definitions, message);
    return <><span>{item.label}</span><input aria-label="Prompt" value={item.prompt} readOnly /><code>{item.id}</code></>;
  }
  const view = render(<GTProvider locale="en" translations={translations}><Options /></GTProvider>);
  expect(screen.getByText("Recording")).toBeVisible();
  view.rerender(<GTProvider locale="ja" translations={translations}><Options /></GTProvider>);
  expect(await screen.findByText("録画中")).toBeVisible();
  expect(screen.getByRole("textbox")).toHaveValue("Recording");
  expect(screen.getByText("recording")).toBeVisible();
});
