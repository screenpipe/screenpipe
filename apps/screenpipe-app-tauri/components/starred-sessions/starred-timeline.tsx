// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { useEffect, useState } from "react";
import { Star } from "lucide-react";
import { emit } from "@tauri-apps/api/event";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { useTauriEvent } from "@/lib/hooks/use-tauri-event";
import { useStarredSessions } from "./use-starred-sessions";
import { StarredSessionPanel } from "./starred-session-panel";

export function StarredTimeline({
  showStrip = false,
}: {
  showStrip?: boolean;
}) {
  const state = useStarredSessions();
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (showStrip) return;
    const openControls = () => setOpen(true);
    const url = new URL(window.location.href);
    if (url.searchParams.get("starred") === "1") {
      setOpen(true);
      url.searchParams.delete("starred");
      window.history.replaceState(window.history.state, "", url);
    }
    window.addEventListener("open-starred-sessions", openControls);
    return () =>
      window.removeEventListener("open-starred-sessions", openControls);
  }, [showStrip]);
  useTauriEvent<{ url: string }>("navigate", (event) => {
    if (
      !showStrip &&
      new URL(event.payload.url, window.location.origin).searchParams.get(
        "starred",
      ) === "1"
    )
      setOpen(true);
  });
  return (
    <>
      {showStrip && (
        <div
          aria-label="Starred moments"
          className="flex shrink-0 items-center gap-2 overflow-x-auto border-b px-3 py-2 text-xs"
        >
          <button
            className="flex shrink-0 items-center gap-1.5 rounded-md border px-2 py-1.5 hover:bg-muted"
            onClick={() =>
              window.dispatchEvent(new Event("open-starred-sessions"))
            }
          >
            <Star
              className={`h-3.5 w-3.5 ${state.active ? "fill-current" : ""}`}
            />
            {state.active ? "Starring" : "Star session"}
          </button>
          {state.sessions.slice(0, 10).map((s) => (
            <button
              key={s.id}
              title={`${new Date(s.start).toLocaleString()} to ${new Date(s.end).toLocaleString()}`}
              className="flex shrink-0 items-center gap-1 rounded-md px-2 py-1.5 text-muted-foreground hover:bg-muted"
              onClick={() => void emit("navigate-to-timestamp", s.start)}
            >
              <Star className="h-3 w-3 fill-current" />
              {new Date(s.start).toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
              })}{" "}
              {new Date(s.start).toLocaleTimeString(undefined, {
                hour: "2-digit",
                minute: "2-digit",
              })}
            </button>
          ))}
        </div>
      )}
      {!showStrip && (
        <Dialog open={open} onOpenChange={setOpen}>
          <DialogContent aria-describedby={undefined} className="max-h-[85vh] max-w-sm overflow-y-auto border-white/20 bg-black p-0 text-white">
            <DialogTitle className="sr-only">Starred sessions</DialogTitle>
            <StarredSessionPanel state={state} inDialog />
          </DialogContent>
        </Dialog>
      )}
    </>
  );
}
