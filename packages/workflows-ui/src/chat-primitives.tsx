// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

"use client";

import React, { forwardRef, memo, useLayoutEffect, useRef } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ChevronDown } from "lucide-react";
import styles from "./chat-primitives.module.css";

// Extracted from Screenpipe's MarkdownBlock. Completed blocks stay formatted
// while only the unfinished tail changes; the final render uses the exact text.
function scanStreamingMarkdown(text: string) {
  let fenceCharacter: string | null = null;
  let fenceLength = 0;
  let lastBoundary = 0;
  let blockStart = 0;
  let lineStart = 0;
  const blocks: string[] = [];
  while (lineStart < text.length) {
    const newlineIndex = text.indexOf("\n", lineStart);
    const lineEnd = newlineIndex === -1 ? text.length : newlineIndex;
    const line = text.slice(lineStart, lineEnd).replace(/\r$/, "");
    const nextLineStart = newlineIndex === -1 ? text.length : newlineIndex + 1;
    const fenceMatch = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
    if (fenceMatch) {
      const marker = fenceMatch[1];
      const character = marker[0];
      if (!fenceCharacter) { fenceCharacter = character; fenceLength = marker.length; }
      else if (character === fenceCharacter && marker.length >= fenceLength && fenceMatch[2].trim() === "") {
        fenceCharacter = null; fenceLength = 0;
      }
    } else if (!fenceCharacter && line.trim() === "") {
      lastBoundary = nextLineStart;
      const block = text.slice(blockStart, lastBoundary);
      if (block.trim()) blocks.push(block);
      blockStart = lastBoundary;
    }
    lineStart = nextLineStart;
  }
  return { prefix: text.slice(0, lastBoundary), blocks };
}

export function stableStreamingMarkdownPrefix(text: string): string {
  return scanStreamingMarkdown(text).prefix;
}

type ChatMarkdownProps = {
  text: string;
  streaming?: boolean;
  className?: string;
  tailClassName?: string;
  /** Main Chat keeps its existing rich-media and native-link adapters. */
  renderBlock?: (text: string, index: number) => React.ReactNode;
  allowLink?: (url: string) => boolean;
  onOpenLink?: (url: string) => void;
};

const FormattedBlock = memo(function FormattedBlock({ text, allowLink, onOpenLink }: Pick<ChatMarkdownProps, "text" | "allowLink" | "onOpenLink">) {
  const allowed = (url: string) => {
    if (allowLink) return allowLink(url);
    try { const link = new URL(url); return ["http:", "https:"].includes(link.protocol) && !link.username && !link.password; }
    catch { return false; }
  };
  return <ReactMarkdown
    remarkPlugins={[remarkGfm]}
    skipHtml
    urlTransform={(url) => allowed(url) ? url : ""}
    components={{
      // A secondary memory answer never fetches arbitrary remote images.
      img: () => null,
      a: ({ href, children }) => href && allowed(href)
        ? <a href={href} target="_blank" rel="noreferrer noopener" onClick={onOpenLink ? (event) => { event.preventDefault(); onOpenLink(href); } : undefined}>{children}</a>
        : <span>{children}</span>,
      table: ({ children }) => <div className={styles.tableScroll} role="region" aria-label="Scrollable table" tabIndex={0}><table>{children}</table></div>,
    }}
  >{text}</ReactMarkdown>;
});

export const ChatMarkdown = memo(function ChatMarkdown({ text, streaming = false, renderBlock, className, tailClassName, ...links }: ChatMarkdownProps) {
  const { blocks, prefix } = streaming ? scanStreamingMarkdown(text) : { blocks: text ? [text] : [], prefix: text };
  const tail = text.slice(prefix.length);
  const content = <>
    {blocks.map((block, index) => renderBlock
      ? <React.Fragment key={index}>{renderBlock(block, index)}</React.Fragment>
      : <FormattedBlock key={index} text={block} {...links} />)}
    {tail && <div className={tailClassName ?? styles.tail} data-testid="streaming-markdown-tail">{tail}</div>}
  </>;
  return renderBlock ? content : <div className={[styles.markdown, className].filter(Boolean).join(" ")}>{content}</div>;
});

type ComposerTextAreaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement> & {
  autoGrow?: boolean;
  onSend?: () => void;
};

/** The same input primitive used by the standalone Chat composer and its embeds. */
export const ComposerTextArea = forwardRef<HTMLTextAreaElement, ComposerTextAreaProps>(function ComposerTextArea({
  autoGrow = true, onSend, onKeyDown, onCompositionStart, onCompositionEnd, ...props
}, forwardedRef) {
  const input = useRef<HTMLTextAreaElement | null>(null);
  const composing = useRef(false);
  useLayoutEffect(() => {
    if (!autoGrow || !input.current) return;
    const element = input.current;
    element.style.height = "auto";
    element.style.height = Math.max(42, Math.min(element.scrollHeight, 160)) + "px";
    element.style.overflowY = element.scrollHeight > 160 ? "auto" : "hidden";
  }, [props.value, autoGrow]);
  return <textarea {...props}
    ref={(element) => { input.current = element; if (typeof forwardedRef === "function") forwardedRef(element); else if (forwardedRef) forwardedRef.current = element; }}
    onCompositionStart={(event) => { composing.current = true; onCompositionStart?.(event); }}
    onCompositionEnd={(event) => { composing.current = false; onCompositionEnd?.(event); }}
    onKeyDown={(event) => {
      onKeyDown?.(event);
      if (!event.defaultPrevented && onSend && event.key === "Enter" && !event.shiftKey && !composing.current && !event.nativeEvent.isComposing && event.keyCode !== 229) {
        event.preventDefault(); onSend();
      }
    }}
  />;
});

export function ChatJumpToLatest({ hasMessages, scrolledUp, onJump, className, anchorClassName }: {
  hasMessages: boolean; scrolledUp: boolean; onJump: () => void;
  className?: string; anchorClassName?: string;
}) {
  if (!hasMessages) return null;
  return <div className={anchorClassName ?? styles.jumpAnchor}>
    <button type="button" data-testid="chat-jump-to-latest" aria-label="Jump to latest" aria-hidden={!scrolledUp}
      tabIndex={scrolledUp ? 0 : -1} onClick={onJump} className={className ?? styles.jump} data-visible={scrolledUp}>
      <ChevronDown size={16} aria-hidden="true" />
    </button>
  </div>;
}
