// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import compiler from "@generaltranslation/compiler";
import { createUnplugin } from "unplugin";
import path from "node:path";
import { appRoot, gtConfig } from "./config.mjs";

// Scope GT to owned interface source. Applying auto-JSX injection to third-party
// components can change their rendering contracts and extracts unrelated text.
export function isInterfaceSource(file) {
  const relative = path.relative(appRoot, file).replaceAll("\\", "/");
  return /^(app|components|lib)\//.test(relative) ||
    /^(?:node_modules\/@screenpipe\/workflows-ui|\.\.\/\.\.\/packages\/workflows-ui)\/src\//.test(relative);
}

export const desktopCompiler = createUnplugin((_, meta) => {
  const plugin = (compiler.default ?? compiler).raw({ gtConfig, autoJsxImportSource: "gt-react", devHotReload: false }, meta);
  // Auto JSX injection operates on React jsx/jsxs calls, after Next's SWC
  // transform. Running before SWC only translates explicit useGT calls.
  return { ...plugin, enforce: "post", transformInclude: (id) => isInterfaceSource(id) && !/\.(test|spec)\./.test(id) && plugin.transformInclude(id) };
});
