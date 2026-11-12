// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

"use client";

import { useState } from "react";
import { Monitor } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

export function ScreenshotFrameRateCard({ value, onChange }: {
  value: number;
  onChange: (fps: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const [error, setError] = useState(false);
  return (
    <Card className="border-border bg-card">
      <CardContent className="px-3 py-2.5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-start space-x-2.5 min-w-0 flex-1">
            <Monitor className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
            <div className="min-w-0">
              <h3 id="screenshot-frame-rate-label" className="text-sm font-medium text-foreground">Screenshot frame rate</h3>
              <p id="screenshot-frame-rate-description" className="text-xs text-muted-foreground mt-0.5">
                Sampling rate for activity-triggered screenshots. Higher rates use more power. HD video has its own frame rate.
              </p>
              {error && <p id="screenshot-frame-rate-error" role="alert" className="text-xs text-destructive mt-1">Enter a positive whole frame rate.</p>}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <Input
              type="number"
              min={1}
              // CMTime uses a positive signed 32-bit timescale.
              max={2_147_483_647}
              step={1}
              className="w-24 h-8 text-xs"
              aria-labelledby="screenshot-frame-rate-label"
              aria-describedby={`screenshot-frame-rate-description${error ? " screenshot-frame-rate-error" : ""}`}
              aria-invalid={error}
              data-testid="screenshot-frame-rate-input"
              value={draft ?? String(value)}
              onChange={(event) => { setDraft(event.target.value); setError(false); }}
              onBlur={(event) => {
                if (draft == null) return;
                if (!event.currentTarget.validity.valid || draft.trim() === "") {
                  setError(true);
                  return;
                }
                const fps = Number(draft);
                if (fps !== value) onChange(fps);
                setDraft(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") event.currentTarget.blur();
                if (event.key === "Escape") { setDraft(null); setError(false); }
              }}
            />
            <span className="text-xs text-muted-foreground">fps</span>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
