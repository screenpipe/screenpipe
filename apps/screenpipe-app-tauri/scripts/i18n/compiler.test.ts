// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { expect, test } from "bun:test";
import ts from "typescript";
import path from "node:path";
import { hashMessage } from "gt-i18n/internal";
import { desktopCompiler } from "./compiler.mjs";
import { appRoot } from "./config.mjs";

test("automatic JSX translates after JSX lowering with the same catalog IDs in dev and production", async () => {
  const plugin = desktopCompiler.raw({}, { framework: "webpack" });
  // Next's SWC loader must run first: the GT pass consumes jsx/jsxs/jsxDEV.
  expect(plugin.enforce).toBe("post");
  const filename = path.join(appRoot, "components/localization-probe.tsx");
  const source = '"use client"; export function Probe({ transcript }) { return <><h3>Auto-start</h3><p>{transcript}</p></>; }';
  for (const jsx of [ts.JsxEmit.ReactJSX, ts.JsxEmit.ReactJSXDev]) {
    const lowered = ts.transpileModule(source, { fileName: filename, compilerOptions: { jsx, target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText;
    const result = await plugin.transform.call({} as any, lowered, filename);
    const code = typeof result === "string" ? result : result?.code ?? "";
    expect(code).toContain("GtInternalTranslateJsx");
    expect(code).toContain(hashMessage("Auto-start", { $format: "JSX" }));
    expect(code).toContain("transcript");
  }
  expect(plugin.transformInclude(path.join(appRoot, "node_modules/third-party/component.tsx"))).toBe(false);
});
