// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

"use client";

import React from "react";
import { Check, Loader2, MessageSquare, Pin, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  listConversations,
  loadConversationFile,
  searchConversations,
  type ConversationMeta,
} from "@/lib/chat-storage";
import { cn } from "@/lib/utils";

const CHAT_PICKER_LIMIT = 50;

function chatDate(timestamp: number): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return "";
  const now = new Date();
  if (date.toDateString() === now.toDateString()) {
    return date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  }
  return date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function conversationToMeta(
  conversation: Awaited<ReturnType<typeof loadConversationFile>>,
): ConversationMeta | null {
  if (!conversation || (conversation.kind ?? "chat") !== "chat") return null;
  return {
    id: conversation.id,
    title: conversation.title || "untitled chat",
    createdAt: conversation.createdAt,
    updatedAt: conversation.updatedAt,
    messageCount: conversation.messages.length,
    pinned: conversation.pinned === true,
    hidden: conversation.hidden === true,
    lastUserMessageAt: conversation.lastUserMessageAt,
    lastContentAt: conversation.lastContentAt,
    lastViewedAt: conversation.lastViewedAt,
    kind: "chat",
    presetId: conversation.presetId,
  };
}

interface PipeChatDestinationPickerProps {
  value?: string;
  disabled?: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (chat: ConversationMeta) => void;
}

export function PipeChatDestinationPicker({
  value,
  disabled,
  open,
  onOpenChange,
  onSelect,
}: PipeChatDestinationPickerProps) {
  const [query, setQuery] = React.useState("");
  const [results, setResults] = React.useState<ConversationMeta[]>([]);
  const [selected, setSelected] = React.useState<ConversationMeta | null>(null);
  const [selectedLoading, setSelectedLoading] = React.useState(Boolean(value));
  const [loading, setLoading] = React.useState(false);
  const [loadError, setLoadError] = React.useState(false);
  const requestId = React.useRef(0);
  const searchInput = React.useRef<HTMLInputElement>(null);

  const loadChats = React.useCallback(async (nextQuery: string) => {
    const id = ++requestId.current;
    setLoading(true);
    setLoadError(false);
    try {
      const chats = nextQuery.trim()
        ? await searchConversations(nextQuery, {
            limit: CHAT_PICKER_LIMIT,
            includeHidden: false,
            kind: "chat",
          })
        : await listConversations({
            limit: CHAT_PICKER_LIMIT,
            includeHidden: false,
            kind: "chat",
          });
      if (requestId.current === id) setResults(chats);
    } catch {
      if (requestId.current === id) setLoadError(true);
    } finally {
      if (requestId.current === id) setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    if (!value) {
      setSelected(null);
      setSelectedLoading(false);
      return;
    }
    let cancelled = false;
    setSelectedLoading(true);
    void loadConversationFile(value)
      .then((conversation) => {
        if (!cancelled) setSelected(conversationToMeta(conversation));
      })
      .catch(() => {
        if (!cancelled) setSelected(null);
      })
      .finally(() => {
        if (!cancelled) setSelectedLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [value]);

  React.useEffect(() => {
    if (!open) return;
    const timeout = window.setTimeout(() => void loadChats(query), query ? 150 : 0);
    return () => window.clearTimeout(timeout);
  }, [loadChats, open, query]);

  React.useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const pinned = results.filter((chat) => chat.pinned);
  const recent = results.filter((chat) => !chat.pinned);
  const unavailable = Boolean(value && !selected && !selectedLoading);

  const renderRows = (chats: ConversationMeta[]) =>
    chats.map((chat) => (
      <button
        key={chat.id}
        type="button"
        role="option"
        aria-selected={chat.id === value}
        className={cn(
          "flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left text-sm outline-none transition-colors",
          "hover:bg-muted focus-visible:bg-muted focus-visible:ring-1 focus-visible:ring-ring",
          chat.id === value && "bg-muted/70",
        )}
        onClick={() => {
          setSelected(chat);
          onSelect(chat);
          onOpenChange(false);
        }}
        onKeyDown={(event) => {
          if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
          const listbox = event.currentTarget.closest('[role="listbox"]');
          const options = Array.from(
            listbox?.querySelectorAll<HTMLButtonElement>('[role="option"]') ?? [],
          );
          if (options.length === 0) return;
          event.preventDefault();
          const current = options.indexOf(event.currentTarget);
          const next = event.key === "Home"
            ? 0
            : event.key === "End"
              ? options.length - 1
              : (current + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
          options[next]?.focus();
        }}
      >
        {chat.pinned ? (
          <Pin className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <MessageSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        <span className="min-w-0 flex-1 truncate">{chat.title || "untitled chat"}</span>
        <span className="shrink-0 text-xs text-muted-foreground">
          {chatDate(chat.updatedAt)}
        </span>
        <Check
          className={cn(
            "h-4 w-4 shrink-0",
            chat.id === value ? "opacity-100" : "opacity-0",
          )}
          aria-hidden="true"
        />
      </button>
    ));

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="secondary"
          disabled={disabled}
          className={cn(
            "h-8 min-w-0 max-w-full justify-between gap-2 rounded-md px-3 text-xs font-normal sm:w-64",
            unavailable && "text-destructive",
          )}
          aria-label="choose an existing chat"
          data-testid="pipe-chat-destination-trigger"
        >
          <span className="truncate">
            {selected?.title ||
              (selectedLoading
                ? "loading chat…"
                : unavailable
                  ? "chat unavailable"
                  : "choose chat")}
          </span>
          <Search className="h-3.5 w-3.5 shrink-0 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="w-[min(28rem,calc(100vw-2rem))] rounded-lg p-0"
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          searchInput.current?.focus();
        }}
      >
        <div className="border-b border-border p-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              ref={searchInput}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "ArrowDown") return;
                const first = document.querySelector<HTMLButtonElement>(
                  '[role="listbox"] [role="option"]',
                );
                if (!first) return;
                event.preventDefault();
                first.focus();
              }}
              placeholder="search chats"
              aria-label="search chats"
              className="h-8 rounded-md pl-8 text-xs"
            />
          </div>
        </div>

        <div className="max-h-80 overflow-y-auto p-1.5" role="listbox" aria-label="chats">
          {loading && results.length === 0 ? (
            <div className="flex items-center justify-center gap-2 px-3 py-8 text-xs text-muted-foreground" role="status">
              <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
              loading chats
            </div>
          ) : loadError ? (
            <div className="space-y-2 px-3 py-6 text-center text-xs text-muted-foreground" role="alert">
              <p>couldn&apos;t load chats</p>
              <Button type="button" size="sm" variant="outline" className="h-7 text-xs" onClick={() => void loadChats(query)}>
                retry
              </Button>
            </div>
          ) : results.length === 0 ? (
            <div className="px-4 py-8 text-center text-xs text-muted-foreground">
              {query ? "no matching chats" : "no chats yet — start a chat, then return here"}
            </div>
          ) : (
            query ? (
              <>{renderRows(results)}</>
            ) : (
              <>
                {pinned.length > 0 && (
                  <div>
                    <p className="px-2.5 pb-1 pt-1 text-[11px] font-medium text-muted-foreground">pinned</p>
                    {renderRows(pinned)}
                  </div>
                )}
                {recent.length > 0 && (
                  <div>
                    <p className="px-2.5 pb-1 pt-2 text-[11px] font-medium text-muted-foreground">
                      recent
                    </p>
                    {renderRows(recent)}
                  </div>
                )}
              </>
            )
          )}
        </div>

        <p className="border-t border-border px-3 py-2 text-[11px] text-muted-foreground">
          the task queues behind any reply already running in this chat
        </p>
      </PopoverContent>
    </Popover>
  );
}
