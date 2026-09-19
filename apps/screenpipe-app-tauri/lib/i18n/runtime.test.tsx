// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import React, { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { GTProvider, initializeGT, T, useGT } from "gt-react";
import { hashMessage } from "gt-i18n/internal";

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

test("React 18 changes bundled JSX and interpolated messages without losing drafts or fetching", async () => {
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
  const view = render(<GTProvider locale="en" translations={translations}><Example /></GTProvider>);
  fireEvent.change(screen.getByRole("textbox", { name: "Draft" }), { target: { value: "private draft" } });
  expect(screen.getByText("Hello Alice")).toBeVisible();
  view.rerender(<GTProvider locale="ja" translations={translations}><Example /></GTProvider>);
  expect(await screen.findByText("設定")).toBeVisible();
  expect(screen.getByText("こんにちは、Aliceさん")).toBeVisible();
  expect(screen.getByRole("textbox", { name: "Draft" })).toHaveValue("private draft");
  expect(fetch).not.toHaveBeenCalled();
});
