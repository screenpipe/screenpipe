// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { commands } from "@/lib/utils/tauri";
import { useTauriEvent } from "@/lib/hooks/use-tauri-event";
import { FocusedSessionControls } from "@/components/starred-sessions/focused-session-controls";
import {
  getCurrentWindow,
  LogicalSize,
  PhysicalPosition,
  currentMonitor,
} from "@tauri-apps/api/window";

export default function StarredSessionsPage() {
  const [visible, setVisible] = useState(true);
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!visible || !content.current) return;
    let disposed = false;
    let sequence = Promise.resolve();
    let previousHeight = 0;
    const observer = new ResizeObserver(() => {
      const height = Math.min(
        420,
        Math.ceil(content.current?.scrollHeight ?? 128),
      );
      if (height === previousHeight) return;
      previousHeight = height;
      sequence = sequence
        .then(async () => {
          if (disposed) return;
          const window = getCurrentWindow();
          await window.setSize(new LogicalSize(308, height));
          const monitor = await currentMonitor();
          if (!monitor || disposed) return;
          const position = await window.outerPosition();
          const size = await window.outerSize();
          const area = monitor.workArea;
          const x = Math.max(
            area.position.x,
            Math.min(
              position.x,
              area.position.x + area.size.width - size.width,
            ),
          );
          const y = Math.max(
            area.position.y,
            Math.min(
              position.y,
              area.position.y + area.size.height - size.height,
            ),
          );
          if (x !== position.x || y !== position.y)
            await window.setPosition(new PhysicalPosition(x, y));
        })
        .catch(() => {
          /* A browser preview or compositor may not allow resizing. */
        });
    });
    observer.observe(content.current);
    return () => {
      disposed = true;
      observer.disconnect();
    };
  }, [visible]);
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
  return (
    <div ref={content} hidden={!visible} className="w-screen bg-transparent p-1">
      <section
        role="dialog"
        aria-label="Starred work sessions"
        className="relative max-h-[412px] overflow-y-auto rounded-lg border border-white/20 bg-black text-white"
      >
        <button
          aria-label="Close session controls"
          className="absolute right-3 top-3 z-10 rounded text-white/60 hover:text-white focus-visible:outline focus-visible:outline-1"
          onClick={() => void hide()}
        >
          <X className="h-4 w-4" />
        </button>
        <FocusedSessionControls
          onDismiss={closeError ? undefined : hide}
          visible={visible}
        />
        {closeError && (
          <p role="alert" className="px-3 pb-3 text-xs">
            Could not close the panel. Try again.
          </p>
        )}
      </section>
    </div>
  );
}
