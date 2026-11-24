// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";

import { useEffect, useState } from "react";
import { useGT } from "gt-react";
import { localFetch } from "@/lib/api";

type RedactionEvent = {
  id: number;
  frame_id: number;
  captured_at: string;
  processed_at: string;
  text_fields: string[] | null;
  image_regions: number | null;
};

const pageSize = 10;

function RedactionEvents() {
  const ui = useGT();
  const [page, setPage] = useState<{ before?: number }>({});
  const [result, setResult] = useState<{ events: RedactionEvent[]; failed: boolean } | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
      setResult({ events: [], failed: true });
    }, 5000);
    const params = new URLSearchParams({ limit: String(pageSize + 1) });
    if (page.before !== undefined) params.set("before", String(page.before));
    void (async () => {
      try {
        const response = await localFetch(`/privacy/redaction-history?${params}`, { signal: controller.signal });
        if (!response.ok) throw new Error("History unavailable");
        const events: RedactionEvent[] = await response.json();
        if (!Array.isArray(events)) throw new Error("Invalid history");
        if (!controller.signal.aborted) setResult({ events, failed: false });
      } catch {
        if (!controller.signal.aborted) setResult({ events: [], failed: true });
      } finally {
        clearTimeout(timeout);
      }
    })();
    return () => {
      clearTimeout(timeout);
      controller.abort();
    };
  }, [page]);

  const fieldLabels: Record<string, string> = {
    full_text: ui("Screen text"),
    accessibility_text: ui("Accessibility text"),
    accessibility_tree_json: ui("Accessibility tree"),
    text_json: ui("OCR words"),
    window_name: ui("Window title"),
    browser_url: ui("Browser URL"),
    app_name: ui("App name"),
    document_path: ui("Document path"),
  };
  function goTo(before?: number) {
    setResult(null);
    setPage({ before });
  }

  const events = result?.events.slice(0, pageSize) ?? [];
  return <div className="mt-2 space-y-2">
    {!result && <p role="status">{ui("Loading redaction history")}</p>}
    {result?.failed && <p role="alert">
      {ui("Redaction history is unavailable.")}{" "}
      <button type="button" className="underline" onClick={() => goTo(page.before)}>{ui("Retry")}</button>
    </p>}
    {result && !result.failed && events.length === 0 && <p>{ui("No protected recording redactions on this page.")}</p>}
    {events.length > 0 && <ul className="divide-y divide-border">
      {events.map((event) => <li key={event.id} className="space-y-1 py-2">
        <p className="font-medium text-foreground">
          {event.text_fields
            ? event.text_fields.map((field) => fieldLabels[field] ?? ui("Other text")).join(", ")
            : <>{ui("Screenshot regions masked")} {event.image_regions}</>}
        </p>
        <p>
          {ui("Captured")} <time dateTime={event.captured_at}>{new Date(event.captured_at).toLocaleString()}</time>
          {" · "}{ui("Frame")} {event.frame_id}
        </p>
        <p>{ui("Processed")} <time dateTime={event.processed_at}>{new Date(event.processed_at).toLocaleString()}</time></p>
      </li>)}
    </ul>}
    <div className="flex flex-wrap gap-3">
      {page.before !== undefined && <button type="button" className="underline" onClick={() => goTo()}>{ui("Newest redactions")}</button>}
      {result && result.events.length > pageSize && <button type="button" className="underline" onClick={() => goTo(events[events.length - 1].id)}>{ui("Older redactions")}</button>}
    </div>
  </div>;
}

export function RedactionHistory() {
  const ui = useGT();
  const [open, setOpen] = useState(false);
  return <details className="mt-3 border-t border-border pt-2 text-xs text-muted-foreground" onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary className="cursor-pointer font-medium text-foreground">{ui("Redaction history")}</summary>
    {open && <RedactionEvents />}
  </details>;
}
