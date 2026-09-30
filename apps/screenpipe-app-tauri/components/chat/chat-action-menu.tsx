// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";

import type React from "react";
import { useRef } from "react";
import {
  Archive,
  Copy,
  GitBranch,
  MoreHorizontal,
  Pencil,
  Pin,
  Undo2,
} from "lucide-react";
import * as Context from "@/components/ui/context-menu";
import * as Dropdown from "@/components/ui/dropdown-menu";
import { usePlatform } from "@/lib/hooks/use-platform";
import { useOptionalSettings } from "@/lib/hooks/use-settings";
import {
  conflictsWithGlobalShortcut,
  inAppShortcutLabel,
  matchesInAppShortcut,
  type InAppShortcutId,
} from "@/lib/shortcuts";
import {
  isEphemeralSideConversation,
  useChatStore,
  type SessionRecord,
} from "@/lib/stores/chat-store";
import { commands } from "@/lib/utils/tauri";
import { chatConversationLink } from "@/lib/chat/conversation-link";
import { formatChatAsMarkdown } from "@/lib/chat/markdown-export";
import type { Message } from "@/lib/chat/types";
import { toast } from "@/components/ui/use-toast";
import { useGT } from "gt-react";

export const CHAT_MENU_ACTION_EVENT = "screenpipe:chat-menu-action";
export const CHAT_MENU_ACTIONS = [
  "rename_chat",
  "pin_chat",
  "branch_chat",
  "archive_chat",
] as const;
export type ChatMenuAction = (typeof CHAT_MENU_ACTIONS)[number];
export type ChatMenuRequest = { id: string; action: ChatMenuAction };

export function useChatActionBindings() {
  const { isMac } = usePlatform();
  const settings = useOptionalSettings()?.settings ?? {};
  const available = (id: InAppShortcutId) =>
    !conflictsWithGlobalShortcut(id, isMac, settings);
  return {
    label: (id: InAppShortcutId) =>
      available(id) ? inAppShortcutLabel(id, isMac) : "",
    match: (event: KeyboardEvent, id: InAppShortcutId) =>
      available(id) && matchesInAppShortcut(event, id, isMac),
  };
}

/** Menus target the row they belong to; closed-menu shortcuts target the active chat. */
export function handleChatMenuShortcut(
  event: React.KeyboardEvent<HTMLElement>,
) {
  if (
    event.defaultPrevented ||
    event.repeat ||
    event.nativeEvent.isComposing ||
    event.nativeEvent.getModifierState?.("AltGraph")
  )
    return;
  const items = event.currentTarget.querySelectorAll<HTMLElement>(
    "[data-chat-shortcut]",
  );
  for (const item of items) {
    if (
      item.dataset.disabled !== undefined ||
      item.getAttribute("aria-disabled") === "true"
    )
      continue;
    const id = item.dataset.chatShortcut as InAppShortcutId;
    const isMac = item.dataset.shortcutPlatform === "mac";
    if (!matchesInAppShortcut(event.nativeEvent, id, isMac)) continue;
    event.preventDefault();
    event.stopPropagation();
    item.click();
    return;
  }
}

const parts = {
  context: {
    Item: Context.ContextMenuItem,
    Shortcut: Context.ContextMenuShortcut,
    Separator: Context.ContextMenuSeparator,
    Sub: Context.ContextMenuSub,
    Trigger: Context.ContextMenuSubTrigger,
    Content: Context.ContextMenuSubContent,
  },
  dropdown: {
    Item: Dropdown.DropdownMenuItem,
    Shortcut: Dropdown.DropdownMenuShortcut,
    Separator: Dropdown.DropdownMenuSeparator,
    Sub: Dropdown.DropdownMenuSub,
    Trigger: Dropdown.DropdownMenuSubTrigger,
    Content: Dropdown.DropdownMenuSubContent,
  },
};

export const CHAT_MENU_CLASS =
  "w-64 rounded-lg border border-border bg-popover p-1 shadow-md";

export function ChatActionMenuItems({
  variant,
  session,
  onAction,
  onBeforeCopy,
  canBranch = true,
}: {
  variant: "context" | "dropdown";
  session: SessionRecord;
  onAction: (action: ChatMenuAction) => void;
  onBeforeCopy?: () => void;
  canBranch?: boolean;
}) {
  const ui = useGT();
  const P = parts[variant];
  const bindings = useChatActionBindings();
  const { isMac } = usePlatform();
  if (isEphemeralSideConversation(session)) return null;
  const items = [
    { id: "rename_chat", label: ui("Rename"), Icon: Pencil },
    {
      id: "pin_chat",
      label: session.pinned ? ui("Unpin") : ui("Pin"),
      Icon: Pin,
    },
    { id: "branch_chat", label: ui("Branch in new chat"), Icon: GitBranch },
    {
      id: "archive_chat",
      label: session.hidden ? ui("Unarchive") : ui("Archive"),
      Icon: session.hidden ? Undo2 : Archive,
    },
  ] as const;
  const copy = async (kind: "link" | "markdown" | "id" | "path") => {
    onBeforeCopy?.();
    try {
      let text =
        kind === "link"
          ? chatConversationLink(session.id)
          : kind === "path"
            ? (session.codingWorkspace?.worktreePath ?? "")
            : session.id;
      if (kind === "markdown") {
        const { loadConversationFile } = await import("@/lib/chat-storage");
        const messages = session.messages?.length
          ? session.messages
          : ((await loadConversationFile(session.id))?.messages ?? []);
        if (!messages.length) {
          toast({ title: ui("No messages to copy") });
          return;
        }
        text = formatChatAsMarkdown(messages as Message[], {
          deferredMessageIds: new Set(),
          aggregatedAfter: new Map(),
        });
      }
      await commands.copyTextToClipboard(text);
      toast({ title: ui("Copied") });
    } catch {
      toast({ title: ui("Couldn't copy chat"), variant: "destructive" });
    }
  };
  return (
    <>
      {items.map(({ id, label, Icon }) => {
        const hint = bindings.label(id);
        return (
          <P.Item
            key={id}
            className="min-h-8 gap-2 rounded-md px-2 text-xs"
            disabled={
              id === "branch_chat" && (!canBranch || session.messageCount === 0)
            }
            data-chat-shortcut={hint ? id : undefined}
            data-shortcut-platform={isMac ? "mac" : "other"}
            onSelect={(event) => {
              event.stopPropagation();
              onAction(id);
            }}
          >
            <Icon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
            <span>{label}</span>
            <P.Shortcut className="ml-auto pl-3 text-[10px] tracking-normal">
              {hint}
            </P.Shortcut>
          </P.Item>
        );
      })}
      <P.Separator />
      <P.Sub>
        <P.Trigger className="min-h-8 gap-2 rounded-md px-2 text-xs">
          <Copy className="h-3.5 w-3.5 text-muted-foreground" />
          {ui("Copy")}
        </P.Trigger>
        <P.Content className="w-48 rounded-lg p-1">
          <P.Item onSelect={() => void copy("link")}>{ui("Copy link")}</P.Item>
          <P.Item onSelect={() => void copy("markdown")}>
            {ui("Copy as Markdown")}
          </P.Item>
          <P.Item onSelect={() => void copy("id")}>{ui("Copy chat ID")}</P.Item>
          {session.codingWorkspace && (
            <P.Item onSelect={() => void copy("path")}>
              {ui("Copy worktree path")}
            </P.Item>
          )}
        </P.Content>
      </P.Sub>
    </>
  );
}

export function ChatActionsDropdown({
  conversationId,
}: {
  conversationId: string | null;
}) {
  const session = useChatStore((state) =>
    conversationId ? state.sessions[conversationId] : undefined,
  );
  const ui = useGT();
  const pendingAction = useRef<ChatMenuRequest | null>(null);
  return (
    <Dropdown.DropdownMenu>
      <Dropdown.DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={ui("Chat actions")}
          title={ui("Chat actions")}
          disabled={!session || isEphemeralSideConversation(session)}
          onMouseDown={(event) => event.stopPropagation()}
          className="flex h-7 w-7 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-40"
        >
          <MoreHorizontal className="h-4 w-4" />
        </button>
      </Dropdown.DropdownMenuTrigger>
      <Dropdown.DropdownMenuContent
        data-chat-actions-menu=""
        align="end"
        className={CHAT_MENU_CLASS}
        onKeyDown={handleChatMenuShortcut}
        onCloseAutoFocus={(event) => {
          const request = pendingAction.current;
          if (!request) return;
          pendingAction.current = null;
          event.preventDefault();
          // Let the menu's focus trap finish before focusing a rename input.
          requestAnimationFrame(() =>
            window.dispatchEvent(
              new CustomEvent<ChatMenuRequest>(CHAT_MENU_ACTION_EVENT, {
                detail: request,
              }),
            ),
          );
        }}
      >
        {session && (
          <ChatActionMenuItems
            variant="dropdown"
            session={session}
            onAction={(action) => {
              pendingAction.current = { id: session.id, action };
            }}
          />
        )}
      </Dropdown.DropdownMenuContent>
    </Dropdown.DropdownMenu>
  );
}
