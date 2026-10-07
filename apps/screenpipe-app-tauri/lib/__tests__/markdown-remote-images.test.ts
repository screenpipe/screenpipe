// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";

// Markdown, diagrams and notes in this app are often written by an AI or a
// pipe working from captured screens, pages and files, so outside content can
// steer their image URLs. A remote image loads the moment it renders and
// sends its URL to that server, with no click. These checks pin which files
// may use each library that renders images, so a new one cannot slip past
// review.

// MemoizedReactMarkdown (components/markdown.tsx) renders only local files as
// images; each other direct react-markdown renderer overrides or excludes img.
const REVIEWED_MARKDOWN_RENDERERS = [
  "../../packages/workflows-ui/src/chat-primitives.tsx", // img renders nothing
  "app/notification-panel/page.tsx", // img shows alt text
  "components/announcement-body.tsx", // img shows alt text
  "components/markdown.tsx", // MemoizedReactMarkdown: local files only
  "components/notification-bell.tsx", // img shows alt text
  "components/settings/live-view-card.tsx", // allowedElements excludes img
];

// Runtime imports of `pkg` or its subpaths; `import type` renders nothing.
function runtimeImportOf(pkg: string): RegExp {
  const spec = `["']${pkg.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&")}(?:/[^"']*)?["']`;
  return new RegExp(
    `\\b(?:import|export)\\s+(?!type\\b)[^;'"]*\\bfrom\\s*${spec}|\\bimport\\s*\\(?\\s*${spec}`,
  );
}

function frontendSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((dirent) => {
    const path = resolve(directory, dirent.name);
    if (dirent.isDirectory()) {
      return dirent.name === "__tests__" || dirent.name === "node_modules"
        ? []
        : frontendSourceFiles(path);
    }
    if (!/\.(?:ts|tsx)$/.test(dirent.name)) return [];
    if (/\.(?:spec|test)\./.test(dirent.name)) return [];
    return [path];
  });
}

// The app's own source and the workflow UI package it bundles, as paths from
// the app folder.
function filesMatching(pattern: RegExp): string[] {
  const root = process.cwd();
  return ["app", "components", "lib", "../../packages/workflows-ui/src"]
    .flatMap((dir) => frontendSourceFiles(resolve(root, dir)))
    .filter((file) => pattern.test(readFileSync(file, "utf8")))
    .map((file) => relative(root, file).replaceAll("\\", "/"))
    .sort();
}

function filesImporting(pkg: string): string[] {
  return filesMatching(runtimeImportOf(pkg));
}

describe("remote images in rendered content", () => {
  it("uses react-markdown only in renderers reviewed for remote images", () => {
    expect(
      filesImporting("react-markdown"),
      "Render markdown with MemoizedReactMarkdown from components/markdown.tsx. " +
        "If a file must use react-markdown directly, give it an `img` component " +
        "that never loads a remote URL (ImageAltText), then add it to " +
        "REVIEWED_MARKDOWN_RENDERERS.",
    ).toEqual(REVIEWED_MARKDOWN_RENDERERS);
  });

  it("parses raw HTML in markdown only where the chat sanitizer follows", () => {
    expect(
      filesImporting("rehype-raw"),
      "Raw HTML in markdown brings tags the img component never sees, such as " +
        "<video poster>. Render it through MarkdownBlock in components/chat/markdown-block.tsx, " +
        "which sanitizes what rehype-raw parses, or sanitize it the same way and add it here.",
    ).toEqual(["components/chat/markdown-block.tsx"]);
  });

  it("never loads Mermaid into the app window", () => {
    expect(
      filesImporting("mermaid"),
      "Mermaid fetches image and CSS URLs from diagram source while it draws. " +
        "Render diagrams with renderMermaidSvg from components/rewind/mermaid-sandbox.ts, " +
        "which runs Mermaid in a frame that cannot reach the network.",
    ).toEqual([]);
    // The no-network frame still has a bundle to load.
    expect(
      readFileSync(resolve(process.cwd(), "components/rewind/mermaid-sandbox.ts"), "utf8"),
    ).toContain('new URL("mermaid/dist/mermaid.min.js", import.meta.url)');
  });

  it("uses the Tiptap image node only in the note editor, which shows embedded images only", () => {
    expect(
      filesImporting("@tiptap/extension-image"),
      "A Tiptap image node loads its src as soon as it renders. Reuse the note " +
        "editor's image extension, which shows only data: images, or give the " +
        "new one the same rule and add it here.",
    ).toEqual(["components/meeting-notes/note-editor.tsx"]);
  });

  it("gives every frame that shows HTML the no-network policy", () => {
    const framesWithoutPolicy = filesMatching(/\bsrcdoc\s*=|setAttribute\(\s*["']srcdoc/i).filter(
      (file) => !/\b(?:SANDBOX_CSP|wrapHtmlForSandbox)\b/.test(readFileSync(resolve(process.cwd(), file), "utf8")),
    );
    expect(
      framesWithoutPolicy,
      "HTML in a frame loads its images, stylesheets and fonts as soon as it " +
        "renders. Start the document with SANDBOX_CSP from lib/utils/html-sandbox.ts, " +
        "or render it with wrapHtmlForSandbox.",
    ).toEqual([]);
  });

  it.each([
    ["react-markdown", `import ReactMarkdown from "react-markdown";`, true],
    ["react-markdown", `import ReactMarkdown, { defaultUrlTransform, Options } from 'react-markdown'`, true],
    ["react-markdown", `import {\n  MarkdownHooks,\n} from "react-markdown";`, true],
    ["react-markdown", `export { default } from "react-markdown";`, true],
    ["react-markdown", `const Markdown = await import("react-markdown");`, true],
    ["react-markdown", `import type { Options } from "react-markdown";`, false],
    ["react-markdown", `import remarkGfm from "remark-gfm";`, false],
    ["mermaid", `const { default: mermaid } = await import("mermaid");`, true],
    ["mermaid", `import mermaid from "mermaid/dist/mermaid.core.mjs";`, true],
    ["mermaid", `import "mermaid";`, true],
    ["mermaid", `import type { Mermaid } from "mermaid";`, false],
    ["mermaid", `new URL("mermaid/dist/mermaid.min.js", import.meta.url)`, false],
    ["mermaid", `import x from "mermaid-lite";`, false],
    ["@tiptap/extension-image", `import Image from "@tiptap/extension-image";`, true],
    ["@tiptap/extension-image", `import Placeholder from "@tiptap/extension-placeholder";`, false],
  ])("detects runtime %s imports in %s", (pkg, source, expected) => {
    expect(runtimeImportOf(pkg).test(source)).toBe(expected);
  });
});
