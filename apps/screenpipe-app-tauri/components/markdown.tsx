// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { createContext, FC, isValidElement, memo, useContext, type ReactNode } from 'react'
import ReactMarkdown, { defaultUrlTransform, Options } from 'react-markdown'
import { commands } from "@/lib/utils/tauri";
import { MediaComponent } from "@/components/rewind/media";
import { LocalMarkdownImage } from "@/components/markdown/local-markdown-image";
import { ImageAltText } from "@/components/markdown/image-alt-text";
import { imageMimeFromName } from "@/components/meeting-notes/image-utils";
import {
  decodeLinkAddress,
  isMediaAddress,
  isMediaFilePath,
  normalizeLocalMediaMarkdown,
  normalizeMediaFilePath,
  runsPastLinkEnd,
} from "@/lib/utils/media-file-path";

function unwrapMarkdownUrl(url: string): string {
  const trimmed = url.trim();
  if (trimmed.startsWith("<") && trimmed.endsWith(">")) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

export function resolveLocalPathFromMarkdownUrl(url: string): string | null {
  const raw = unwrapMarkdownUrl(url);
  if (!raw || raw.startsWith("screenpipe://")) {
    return null;
  }

  const urlWithoutFragment = raw.split("#", 1)[0] ?? raw;

  let candidate = urlWithoutFragment;

  if (/^file:\/\//i.test(candidate)) {
    const withoutScheme = candidate.replace(/^file:\/\//i, "");
    candidate = `/${withoutScheme.replace(/^\/+/, "")}`;
  }

  try {
    candidate = decodeURIComponent(candidate);
  } catch {
    // Keep the original string when the markdown contains malformed escapes.
  }

  if (/^\/[A-Za-z]:[\\/]/.test(candidate)) {
    candidate = candidate.slice(1);
  }

  // A second leading slash or backslash is a network share on Windows
  // (//host/share, /\host\share); reading it would contact that host.
  if (/^\/(?![\\/])/.test(candidate)) {
    return candidate;
  }

  if (/^[A-Za-z]:[\\/]/.test(candidate)) {
    return candidate;
  }

  return null;
}

export function createScreenpipeUrlTransform(allowedHosts: readonly string[]) {
  const allowed = new Set(allowedHosts);

  return (url: string): string => {
    // react-markdown's default sanitizer strips file:// and would leave
    // local chat images with an empty src. Keep absolute paths intact.
    if (resolveLocalPathFromMarkdownUrl(url)) {
      return url;
    }

    try {
      const parsed = new URL(url);
      if (parsed.protocol === "screenpipe:" && allowed.has(parsed.host)) {
        return url;
      }
    } catch {
      // Fall back to react-markdown's default sanitizer for malformed URLs.
    }

    return defaultUrlTransform(url);
  };
}

export const notificationUrlTransform = createScreenpipeUrlTransform(["view"]);
export const viewerUrlTransform = createScreenpipeUrlTransform(["view"]);
export const chatUrlTransform = createScreenpipeUrlTransform([
  "timeline",
  "frame",
  "meeting",
  "view",
]);

export function screenpipeViewerPathFromHref(href: string): string | null {
  try {
    const url = new URL(href);
    if (url.protocol !== "screenpipe:" || url.host !== "view") {
      return null;
    }
    return url.searchParams.get("path");
  } catch {
    return null;
  }
}

export async function openScreenpipeViewerLink(href: string): Promise<boolean> {
  const path = screenpipeViewerPathFromHref(href);
  if (!path) return false;

  const result = await commands.openViewerWindow(path);
  if (result.status === "error") {
    throw new Error(result.error);
  }
  return true;
}

// A `<…>` link address can't hold `<` or `>`, and a device name can.
function wrapPathForMarkdown(path: string): string {
  return `<${path.replace(/</g, "%3C").replace(/>/g, "%3E")}>`;
}

function rewriteLocalMediaLinksForChat(text: string): string {
  return text.replace(
    // The path stops before another link's `](` so two links on a line stay two.
    /(!?)\[([^\]]*)\]\(((?:file:\/\/\/?|\/|[A-Z]:[\\/])(?:(?!\]\()[^\n\r])+?\.(mp4|mp3|wav|webm|ogg|m4a))\)/gi,
    (match, sigil: string, label: string, rawPath: string) => {
      if (runsPastLinkEnd(rawPath)) return match;
      // Rewrite only a path the player reads whole. Shortening anything else
      // (`/Music/old.mp3-files/clip.mp4`) would name a different file.
      const localPath = resolveLocalPathFromMarkdownUrl(rawPath);
      if (!localPath || !isMediaFilePath(localPath)) return match;
      return `${sigil}[${label}](${wrapPathForMarkdown(normalizeMediaFilePath(localPath))})`;
    },
  );
}

export function rewriteLocalMarkdownLinksForChat(text: string): string {
  return rewriteLocalMediaLinksForChat(text).replace(
    /(!?)\[([^\]\n]+)\]\((<[^>\n]+>|[^)\n]+)\)/g,
    (match, sigil: string, label: string, rawUrl: string) => {
      // An image, or one a link is wrapped around (`[![shot](/a.png)](…)`).
      if (sigil === "!" || label.includes("![")) {
        return match;
      }

      const localPath = resolveLocalPathFromMarkdownUrl(rawUrl);
      if (!localPath) {
        return match;
      }

      if (isMediaFilePath(localPath)) {
        return `[${label}](${wrapPathForMarkdown(normalizeMediaFilePath(localPath))})`;
      }

      return `[${label}](screenpipe://view?path=${encodeURIComponent(localPath)})`;
    },
  );
}

type MarkdownComponents = NonNullable<Options["components"]>;

// A web address (`https:`, `mailto:`, `//host`) that opens by itself. Requiring
// two letters before the colon keeps a Windows drive (`C:`) from matching. A
// `file:` address names a file, not a page: clicking one does nothing on macOS,
// and on Windows `file://host/share` could reach out to that host.
const WEB_ADDRESS = /^(?!file:)(?:[a-z][a-z\d+.-]+:|\/\/)/i;

// The words a node renders, such as a link's label.
function textOf(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return "";
}

function normalizeMarkdownChildren(children: Options["children"]): Options["children"] {
  if (typeof children === "string") {
    return normalizeLocalMediaMarkdown(children);
  }
  return children;
}

// True inside a link's words. A link there would nest in it, and one click
// would open both.
const InsideLink = createContext(false);

function OutsideLinkOnly({ children, inside }: { children: ReactNode; inside: ReactNode }) {
  return <>{useContext(InsideLink) ? inside : children}</>;
}

export function createMediaAwareMarkdownComponents(
  components: Options["components"],
): MarkdownComponents {
  const base = components ?? {};

  // An address with nothing to show reads the way inline code does here, on
  // its line: a decoded line break would make it a code block.
  const addressAsCode = (address: string) => {
    const name = decodeLinkAddress(address).replace(/[\r\n]+/g, " ");
    const CustomCode = base.code;
    return CustomCode ? <CustomCode>{name}</CustomCode> : <code>{name}</code>;
  };

  // A link or image with nothing to play or show keeps its words (an image's
  // alt text) and shows the address it named, alone if the words are empty or
  // that address. Nothing in the app opens a relative address, so leaving it
  // a link would do nothing when clicked.
  const addressAsText = (address: string, words: ReactNode) => {
    const said = textOf(words).trim();
    return !said || said === decodeLinkAddress(address).trim() ? (
      addressAsCode(address)
    ) : (
      <>{words} {addressAsCode(address)}</>
    );
  };

  const link = (href: string | undefined, children: ReactNode, props = {}) => {
    const CustomAnchor = base.a;
    if (CustomAnchor) {
      return <CustomAnchor href={href} {...props}>{children}</CustomAnchor>;
    }
    return <a href={href} {...props}>{children}</a>;
  };

  // An image that doesn't show keeps its alt text and where it pointed, so it
  // never vanishes without a trace. A web address becomes a link, which opens
  // only when clicked.
  const imageAsText = (src: string | undefined, alt: string | undefined) => {
    // The url transform removed an unsafe address; there is none to show.
    if (!src) return <ImageAltText alt={alt} />;
    if (!WEB_ADDRESS.test(src)) return addressAsText(src, alt);
    return <OutsideLinkOnly inside={alt || src}>{link(src, alt || src)}</OutsideLinkOnly>;
  };

  return {
    ...base,
    a({ href, children, ...props }) {
      if (href && isMediaFilePath(href)) {
        return (
          <MediaComponent
            filePath={href}
            className="my-2"
            fallback={addressAsText(href, children)}
          />
        );
      }
      if (href && isMediaAddress(href) && !WEB_ADDRESS.test(href)) {
        return addressAsText(href, children);
      }
      return link(href, <InsideLink.Provider value>{children}</InsideLink.Provider>, props);
    },
    img({ src, alt }) {
      // An <img> can't show audio or video, so a local media file plays.
      if (src && isMediaFilePath(src)) {
        return <MediaComponent filePath={src} className="my-2" fallback={imageAsText(src, alt)} />;
      }

      const localPath = src ? resolveLocalPathFromMarkdownUrl(src) : null;
      if (localPath && imageMimeFromName(localPath)) {
        return (
          <LocalMarkdownImage
            path={localPath}
            alt={alt}
            className="max-w-full h-auto rounded-md my-2 border border-border"
            fallback={imageAsText(src, alt)}
          />
        );
      }

      // Media that can't play isn't a picture: it keeps its link or address
      // even where a caller hides images.
      if (src && isMediaAddress(src)) return imageAsText(src, alt);

      // Only local files render as images. A caller's img never receives the
      // src, so it cannot load it either.
      const CustomImage = base.img;
      if (CustomImage) {
        return <CustomImage alt={alt} />;
      }

      return imageAsText(src, alt);
    },
    code({ className, children, ...props }) {
      const CustomCode = base.code;
      const codeText = CustomCode ? (
        <CustomCode className={className} {...props}>{children}</CustomCode>
      ) : (
        <code className={className} {...props}>{children}</code>
      );

      const content = String(children).replace(/\n$/, "").trim();
      if (isMediaFilePath(content)) {
        return <MediaComponent filePath={content} className="my-2" fallback={codeText} />;
      }
      return codeText;
    },
  };
}

const ReactMarkdownWithMedia: FC<Options> = (props) => (
  <ReactMarkdown
    {...props}
    components={createMediaAwareMarkdownComponents(props.components)}
  >
    {normalizeMarkdownChildren(props.children)}
  </ReactMarkdown>
);

export const MemoizedReactMarkdown: FC<Options> = memo(
  ReactMarkdownWithMedia,
  (prevProps, nextProps) =>
    prevProps.children === nextProps.children &&
    prevProps.className === nextProps.className &&
    prevProps.urlTransform === nextProps.urlTransform
)
