// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";

import React, { createContext, useContext, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useGT } from "gt-react";
import { commands } from "@/lib/utils/tauri";
import { toast } from "@/components/ui/use-toast";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { LinkPreviewAnchor } from "./link-preview-anchor";

// Only surfaces that actually mount BrowserSidebar supply an owner. Other
// MarkdownBlock consumers (meeting notes, notifications) keep external links.
export const ChatLinkBrowserContext = createContext<string | null>(null);

type ChatWebLinkProps = React.AnchorHTMLAttributes<HTMLAnchorElement> & { href: string };

export function ChatWebLink({ href, children, ...props }: ChatWebLinkProps) {
  const conversationId = useContext(ChatLinkBrowserContext);
  const ui = useGT();
  const [menuOpen, setMenuOpen] = useState(false);
  const run = async (action: () => Promise<unknown>, failure: string) => {
    try {
      await action();
    } catch {
      toast({ title: failure, variant: "destructive" });
    }
  };
  const openExternal = () => run(() => openUrl(href), ui("Couldn't open link"));
  const openInBrowser = () => run(async () => {
    if (!conversationId) return openUrl(href);
    const result = await commands.ownedBrowserNavigate(href, conversationId, true);
    if (result.status === "error") throw new Error(result.error);
  }, ui("Couldn't open link. Try Open in external browser."));

  return (
    <ContextMenu onOpenChange={setMenuOpen}>
      <ContextMenuTrigger asChild onContextMenu={(event) => event.stopPropagation()}>
        <span>
          <LinkPreviewAnchor
            {...props}
            href={href}
            disablePreview={menuOpen}
            target="_blank"
            rel="noopener noreferrer"
            onClick={(event) => {
              props.onClick?.(event);
              if (event.defaultPrevented) return;
              event.preventDefault();
              if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
                void openExternal();
              } else {
                void openInBrowser();
              }
            }}
            onAuxClick={(event) => {
              props.onAuxClick?.(event);
              if (event.defaultPrevented || event.button !== 1) return;
              event.preventDefault();
              void openExternal();
            }}
            onKeyDown={(event) => {
              props.onKeyDown?.(event);
              if (event.defaultPrevented) return;
              if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
                event.preventDefault();
                const rect = event.currentTarget.getBoundingClientRect();
                event.currentTarget.dispatchEvent(new MouseEvent("contextmenu", {
                  bubbles: true, cancelable: true, clientX: rect.left, clientY: rect.bottom,
                }));
              }
            }}
          >{children}</LinkPreviewAnchor>
        </span>
      </ContextMenuTrigger>
      <ContextMenuContent data-chat-actions-menu="" className="min-w-56 not-prose">
        {conversationId && <ContextMenuItem onSelect={() => void openInBrowser()}>
          {ui("Open in side browser")}
        </ContextMenuItem>}
        <ContextMenuItem onSelect={() => void openExternal()}>
          {ui("Open in external browser")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={() => void run(async () => {
          const result = await commands.copyTextToClipboard(href);
          if (result.status === "error") throw new Error(result.error);
          toast({ title: ui("Link copied") });
        }, ui("Couldn't copy link"))}>
          {ui("Copy link")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
