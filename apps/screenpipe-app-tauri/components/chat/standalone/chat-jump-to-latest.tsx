// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

"use client";

import { ChatJumpToLatest as SharedJumpToLatest } from "@screenpipe/workflows-ui/chat";
export type ChatJumpToLatestProps = { hasMessages: boolean; scrolledUp: boolean; onJump: () => void };

// Keep standalone Chat's existing visual treatment around the shared behavior.
export function ChatJumpToLatest(props: ChatJumpToLatestProps) {
  return <SharedJumpToLatest {...props}
    anchorClassName="pointer-events-none absolute inset-x-0 top-0 z-20 h-0"
    className={[
      "absolute left-1/2 bottom-2 flex h-8 w-8 -translate-x-1/2 items-center justify-center rounded-none border bg-background text-foreground shadow-none",
      "hover:bg-foreground hover:text-background focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-foreground border-foreground/50",
      props.scrolledUp ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0",
    ].join(" ")}
  />;
}
