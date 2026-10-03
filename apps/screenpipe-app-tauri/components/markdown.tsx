// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { FC, isValidElement, memo, type ReactNode } from 'react'
import ReactMarkdown, { defaultUrlTransform, Options } from 'react-markdown'
import { commands } from "@/lib/utils/tauri";
import { MediaComponent } from "@/components/rewind/media";
import { LocalMarkdownImage } from "@/components/markdown/local-markdown-image";
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
  let wasFileUri = false;

  if (/^file:\/\//i.test(candidate)) {
    wasFileUri = true;
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

  if (candidate.startsWith("/") && (wasFileUri || !candidate.startsWith("//"))) {
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
      if (sigil === "!") {
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
// two letters before the colon keeps a Windows drive (`C:`) from matching.
const WEB_ADDRESS = /^(?:[a-z][a-z\d+.-]+:|\/\/)/i;

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

export function createMediaAwareMarkdownComponents(
  components: Options["components"],
): MarkdownComponents {
  const base = components ?? {};

  // A media name with nothing to play reads the way inline code does here.
  const mediaNameAsText = (address: string) => {
    const name = decodeLinkAddress(address);
    const CustomCode = base.code;
    return CustomCode ? <CustomCode>{name}</CustomCode> : <code>{name}</code>;
  };

  // A media link or image with nothing to play keeps its words (an image's
  // alt text) and shows the address it named, alone if the words are empty or
  // that address. Nothing in the app opens a relative address, so leaving it
  // a link would do nothing when clicked.
  const mediaLinkAsText = (address: string, words: ReactNode) => {
    const said = textOf(words).trim();
    return !said || said === decodeLinkAddress(address).trim() ? (
      mediaNameAsText(address)
    ) : (
      <>{words} {mediaNameAsText(address)}</>
    );
  };

  const link = (href: string | undefined, children: ReactNode, props = {}) => {
    const CustomAnchor = base.a;
    if (CustomAnchor) {
      return <CustomAnchor href={href} {...props}>{children}</CustomAnchor>;
    }
    // A plain web link would load the site inside the app window. The opener
    // plugin sends `_blank` http(s) clicks to the system browser instead.
    const webLink = href && /^https?:/i.test(href)
      ? { target: "_blank", rel: "noopener noreferrer" }
      : {};
    return <a href={href} {...props} {...webLink}>{children}</a>;
  };

  return {
    ...base,
    a({ href, children, ...props }) {
      if (href && isMediaFilePath(href)) {
        return (
          <MediaComponent
            filePath={href}
            className="my-2"
            fallback={mediaLinkAsText(href, children)}
          />
        );
      }
      if (href && isMediaAddress(href) && !WEB_ADDRESS.test(href)) {
        return mediaLinkAsText(href, children);
      }
      return link(href, children, props);
    },
    img({ src, alt, ...props }) {
      if (!src) return null;

      // An <img> can't show audio or video, so a media address plays, opens
      // as a web link, or reads as text.
      if (isMediaFilePath(src)) {
        return <MediaComponent filePath={src} className="my-2" fallback={mediaLinkAsText(src, alt)} />;
      }
      if (isMediaAddress(src)) {
        return WEB_ADDRESS.test(src) ? link(src, alt || src) : mediaLinkAsText(src, alt);
      }

      const localPath = resolveLocalPathFromMarkdownUrl(src);
      if (localPath && imageMimeFromName(localPath)) {
        return (
          <LocalMarkdownImage
            path={localPath}
            alt={alt}
            className="max-w-full h-auto rounded-md my-2 border border-border"
          />
        );
      }

      const CustomImage = base.img;
      if (CustomImage) {
        return <CustomImage src={src} alt={alt} {...props} />;
      }

      return (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={src}
          alt={alt || ""}
          className="max-w-full h-auto rounded-md my-2 border border-border"
          loading="lazy"
          {...props}
        />
      );
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
