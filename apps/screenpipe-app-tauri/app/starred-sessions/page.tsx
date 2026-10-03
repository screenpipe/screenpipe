// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";

import { useCallback, useEffect, useState } from "react";
import { X } from "lucide-react";
import { commands } from "@/lib/utils/tauri";
import { useTauriEvent } from "@/lib/hooks/use-tauri-event";
import { StarredSessionPanel } from "@/components/starred-sessions/starred-session-panel";
import { useStarredSessions } from "@/components/starred-sessions/use-starred-sessions";

function SessionControls() {
  return <StarredSessionPanel state={useStarredSessions()} inDialog />;
}

export default function StarredSessionsPage() {
  const [visible, setVisible] = useState(true);
  const [closeError, setCloseError] = useState(false);
  useTauriEvent<boolean>("starred-sessions-visibility", (event) =>
    setVisible(event.payload),
  );
  const hide = useCallback(async () => {
    setCloseError(false);
    try {
      const result = await commands.hideStarredSessions();
      if (result.status === "ok") setVisible(false);
      else setCloseError(true);
    } catch {
      setCloseError(true);
    }
  }, []);
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Escape inside an inline time editor belongs to that editor first.
      if (event.key === "Escape" && !event.defaultPrevented) void hide();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [hide]);
  if (!visible) return null;
  return (
    <div className="h-screen w-screen bg-transparent p-1">
      <section
        role="dialog"
        aria-label="Starred work sessions"
        className="relative max-h-full overflow-y-auto rounded-lg border border-white/20 bg-black text-white"
      >
        <button
          autoFocus
          aria-label="Close session controls"
          className="absolute right-3 top-3 z-10 rounded text-white/60 hover:text-white focus-visible:outline focus-visible:outline-1"
          onClick={() => void hide()}
        >
          <X className="h-4 w-4" />
        </button>
        <SessionControls />
        {closeError && (
          <p role="alert" className="px-3 pb-3 text-xs">
            Could not close the panel. Try again.
          </p>
        )}
      </section>
    </div>
  );
}
