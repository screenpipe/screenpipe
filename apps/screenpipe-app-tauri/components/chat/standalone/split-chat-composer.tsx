// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useGT } from "gt-react";
import { AttachmentTray } from "./attachment-tray";
import { ComposerControlsRow } from "./composer-controls-row";
import { ComposerInputBox } from "./composer-input-box";
import { DropOverlay } from "./drop-overlay";
import { QueuedPromptsList } from "./queued-prompts-list";
import { useChatAttachments } from "./hooks/use-chat-attachments";
import { useChatMentions } from "./hooks/use-chat-mentions";
import { useChatComposerShellActions } from "./hooks/use-chat-composer-shell";
import { useChatQueue } from "./hooks/use-chat-queue";
import { useCodingWorkspace } from "./hooks/use-coding-workspace";
import { useSessionDraftField } from "./hooks/use-session-draft-field";
import type { SplitControlAction } from "./hooks/use-split-chat-actions";
import type {
  ComposerFiltersProps,
  ComposerModelControlsProps,
} from "./composer-types";
import { useChatStore } from "@/lib/stores/chat-store";
import { getComposerPrimaryAction } from "@/lib/chat-queue-controls";
import type { Message } from "@/lib/chat/types";

type FilterData = Pick<
  ComposerFiltersProps,
  | "staticMentionSuggestions"
  | "appMentionSuggestions"
  | "allTagMentionSuggestions"
  | "tagMentionSections"
  | "appsLoading"
  | "tagsLoading"
  | "connections"
  | "isWindows"
> & {
  appTagMap: Record<string, string>;
  tagMentionSuggestions: Parameters<
    typeof useChatMentions
  >[0]["tagMentionSuggestions"];
};
interface SplitChatComposerProps {
  sessionId: string;
  title: string;
  pending: boolean;
  disabledReason?: string;
  isMac: boolean;
  isEmbedded: boolean;
  enabled: boolean;
  filterData: FilterData;
  modelControls: ComposerModelControlsProps;
  onSend: (id: string) => void;
  onStop: (id: string) => void;
  onControl: (id: string, action: SplitControlAction) => void;
  onOpenConversation: (id: string) => void | Promise<void>;
  onOpenImageViewer: (images: string[], index: number) => void;
}

/** Each pane owns its input and utilities; transport actions restore their
 * target through the existing session controller before dispatching. */
export function SplitChatComposer({
  sessionId,
  title,
  pending,
  disabledReason,
  isMac,
  isEmbedded,
  enabled,
  filterData,
  modelControls,
  onSend,
  onStop,
  onControl,
  onOpenConversation,
  onOpenImageViewer,
}: SplitChatComposerProps) {
  const ui = useGT();
  const session = useChatStore((state) => state.sessions[sessionId]);
  const [input, setInput] = useSessionDraftField<"input", string>(
    sessionId,
    "input",
    "",
  );
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const sectionRef = useRef<HTMLDivElement>(null);
  const dropRootRef = useRef<HTMLDivElement | null>(null);
  const chipPrefixRef = useRef<HTMLDivElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const [, setChipScrollTop] = useState(0);
  const sessionRef = useRef(sessionId);
  const steerInFlight = useRef(false);
  const working =
    !!session && ["streaming", "thinking", "tool"].includes(session.status);
  const canChat = enabled && !pending && !disabledReason;
  const atMentionSuggestions = useMemo(
    () => [
      ...filterData.staticMentionSuggestions,
      ...filterData.appMentionSuggestions,
    ],
    [filterData.staticMentionSuggestions, filterData.appMentionSuggestions],
  );
  const mentions = useChatMentions({
    input,
    setInput,
    inputRef,
    hasConnectionChip: false,
    setChipScrollTop,
    appTagMap: filterData.appTagMap,
    atMentionSuggestions,
    tagMentionSuggestions: filterData.tagMentionSuggestions,
    allTagMentionSuggestions: filterData.allTagMentionSuggestions,
    onOpenConversation,
    onRunCommand: (command) =>
      onControl(sessionId, { type: "command", command }),
  });
  useEffect(() => {
    dropRootRef.current =
      sectionRef.current?.closest("[data-chat-pane-id]") ?? sectionRef.current;
  }, []);
  const attachments = useChatAttachments({
    isEmbedded: isEmbedded && enabled,
    draftSessionId: sessionId,
    scopeDrops: true,
    dropRootRef,
    inputRef,
    setInput,
    setShowMentionDropdown: mentions.setShowMentionDropdown,
    setMentionFilter: mentions.setMentionFilter,
  });
  const queue = useChatQueue(sessionId, sessionRef);
  const workspace = useCodingWorkspace({
    conversationId: sessionId,
    registerE2eHooks: false,
    locked: (session?.messages?.length ?? 0) > 0,
  });
  const submit = async () => {
    if (canChat) onSend(sessionId);
  };
  const shell = useChatComposerShellActions({
    globalShortcutsEnabled: false,
    input,
    setInput,
    inputRef,
    connectionChip: null,
    // Connection context remains literal in this session's draft on paste.
    setConnectionChip: () => {},
    isKnownConnectionId: () => false,
    isMac,
    isComposing: mentions.isComposing,
    mentions: {
      isOpen:
        mentions.showMentionDropdown && mentions.filteredMentions.length > 0,
      selectedIndex: mentions.selectedMentionIndex,
      suggestions: mentions.filteredMentions,
    },
    mentionActions: {
      close: () => mentions.setShowMentionDropdown(false),
      selectNext: () =>
        mentions.setSelectedMentionIndex((index) =>
          Math.min(index + 1, mentions.filteredMentions.length - 1),
        ),
      selectPrevious: () =>
        mentions.setSelectedMentionIndex((index) => Math.max(index - 1, 0)),
      insert: mentions.insertMention,
    },
    pastedImages: attachments.pastedImages,
    pendingDocsRef: attachments.pendingDocsRef,
    attachedDocsRef: attachments.attachedDocsRef,
    messageHistory: ((session?.messages as Message[]) ?? [])
      .filter((message) => message.role === "user")
      .map((message) => message.content),
    queuedPrompts: queue.queuedPrompts,
    steerShortcutInFlightRef: steerInFlight,
    handlePastedFiles: attachments.handlePastedFiles,
    attachPastedText: attachments.attachPastedText,
    sendMessage: submit,
    steerMessage: async (text) => {
      if (canChat) onControl(sessionId, { type: "steer", text });
    },
    steerQueuedPrompt: async (prompt) => {
      if (canChat) onControl(sessionId, { type: "steer-queued", prompt });
    },
  });
  const hasInput =
    !!input.trim() ||
    attachments.pastedImages.length > 0 ||
    attachments.attachedDocs.length > 0;
  const stopMode = getComposerPrimaryAction(working, hasInput) === "stop";
  const hasPendingDocs = attachments.pendingDocs.length > 0;
  return (
    <div
      ref={sectionRef}
      data-testid="chat-composer"
      className="relative shrink-0 border-t border-border/60 bg-background"
    >
      {session?.status === "error" && session.lastError && (
        <p className="px-6 pt-2 text-xs text-destructive" role="status">
          {session.lastError}
        </p>
      )}
      <AttachmentTray
        pendingDocs={attachments.pendingDocs}
        attachedDocs={attachments.attachedDocs}
        pastedImages={attachments.pastedImages}
        onShowPastedTextInField={attachments.showPastedTextInField}
        onRemoveDoc={(index) =>
          attachments.setAttachedDocs((docs) =>
            docs.filter((_, i) => i !== index),
          )
        }
        onImageClick={onOpenImageViewer}
        onRemoveImage={(index) =>
          attachments.setPastedImages((images) =>
            images.filter((_, i) => i !== index),
          )
        }
      />
      <form
        className="relative px-5 sm:px-6 pb-3 pt-2"
        aria-label={ui("Message {value1}", { value1: title })}
        onSubmit={shell.handleSubmit}
        onPaste={shell.handlePaste}
      >
        <DropOverlay
          isEmbedded={isEmbedded}
          isDragging={attachments.isDragging}
        />
        <QueuedPromptsList
          queuedPrompts={queue.queuedPrompts}
          queuedActionPromptId={queue.queuedActionPromptId}
          queuedScrollRef={queue.queuedScrollRef}
          isMac={isMac}
          onSteerQueuedPrompt={(prompt) =>
            onControl(sessionId, { type: "steer-queued", prompt })
          }
          onCancelQueuedPrompt={queue.cancelQueuedPrompt}
        />
        <ComposerInputBox
          input={{
            sectionRef,
            inputRef,
            value: input,
            ariaLabel: ui("Message {value1}", { value1: title }),
            disabledReason: disabledReason ?? null,
            placeholder: working ? ui("Message will be queued...") : undefined,
            canChat,
            isLoading: working,
            isStreaming: working,
            isEmbedded,
            isDragging: attachments.isDragging,
            connectionChip: null,
            chipPrefixRef,
            chipPrefixWidth: 0,
            chipScrollTop: 0,
            onClearConnectionChip: () => {},
            onValueChange: setInput,
            onChange: mentions.handleMentionInputChange,
            onCompositionStart: () => mentions.setIsComposing(true),
            onCompositionEnd: () => mentions.setIsComposing(false),
            onTextareaScroll: () => {},
            onKeyDown: shell.handleKeyDown,
            onSubmit: shell.handleSubmit,
            onPaste: shell.handlePaste,
          }}
          mentions={{
            show: mentions.showMentionDropdown,
            suggestions: mentions.filteredMentions,
            dropdownRef,
            selectedIndex: mentions.selectedMentionIndex,
            onInsertMention: mentions.insertMention,
            isLoadingSpeakers: mentions.isLoadingSpeakers,
            isLoadingTagSearch: mentions.isLoadingTagSearch,
          }}
        />
        <ComposerControlsRow
          canChat={canChat}
          pending={pending}
          isStreaming={working}
          filters={{
            ...filterData,
            appFilterOpen: mentions.appFilterOpen,
            onFilterMenuOpenChange: mentions.handleFilterMenuOpenChange,
            hasActiveFilters: !!mentions.hasActiveFilters,
            activeFilterCount: mentions.activeFilterCount,
            activeFilters: mentions.activeFilters,
            activeFilterLabels: mentions.activeFilterLabels,
            filterSearch: mentions.filterSearch,
            onFilterSearchChange: mentions.updateFilterSearch,
            onClearFilterSearch: mentions.clearFilterSearch,
            filterSearchGroups: mentions.filterSearchGroups,
            filterSearchResults: mentions.filterSearchResults,
            isLoadingFilterSearch: mentions.isLoadingFilterSearch,
            selectedFilterResultIndex: mentions.selectedFilterResultIndex,
            onSelectFilterResultIndex: mentions.selectFilterResultIndex,
            onSelectNextFilterResult: mentions.selectNextFilterResult,
            onSelectPreviousFilterResult: mentions.selectPreviousFilterResult,
            onApplySelectedFilterResult: mentions.applySelectedFilterResult,
            recentSpeakers: mentions.recentSpeakers,
            onCloseFilterMenu: mentions.closeFilterMenu,
            getFilterSuggestionState: mentions.getFilterSuggestionState,
            applyFilterSuggestion: mentions.applyFilterSuggestion,
            applyTimeFilterSuggestion: mentions.applyTimeFilterSuggestion,
            applyContentFilterSuggestion: mentions.applyContentFilterSuggestion,
            applyAppFilterSuggestion: mentions.applyAppFilterSuggestion,
            applyTagFilterSuggestion: mentions.applyTagFilterSuggestion,
            applyConnectionFilterTag: mentions.applyConnectionFilterTag,
            applySpeakerFilterSuggestion: mentions.applySpeakerFilterSuggestion,
            onPickFiles: attachments.handleFilePicker,
          }}
          modelControls={modelControls}
          codingWorkspace={{
            ...workspace,
            disabled: true,
            onToggle: workspace.toggleWorktree,
          }}
          dictation={{
            inputValue: input,
            inputRef,
            onValueChange: setInput,
            disabled: !canChat,
            sessionId,
            isMac,
            shortcutsEnabled: false,
          }}
          sendButton={{
            isStopMode: stopMode,
            hasPendingDocs,
            sendDisabled:
              pending ||
              (!stopMode && (!canChat || hasPendingDocs || !hasInput)),
            onStop: () => onStop(sessionId),
          }}
        />
      </form>
    </div>
  );
}
