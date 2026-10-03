// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

"use client";

import { msg, useMessages } from "gt-react";
import { Monitor } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { RecordingDetail } from "@/lib/utils/tauri";

const descriptions: Record<RecordingDetail, string> = {
  auto: msg("Adjusts scroll snapshots between 1 and 5 seconds based on capture speed and your power profile.", {}),
  low_impact: msg("Fewer snapshots during scrolling, about one every 5 seconds.", {}),
  balanced: msg("Snapshots during scrolling about every 2 seconds.", {}),
  more_detail: msg("More snapshots during scrolling, about one every second. Uses more CPU and storage.", {}),
};

export function RecordingDetailCard({ value, onChange }: {
  value: RecordingDetail;
  onChange: (value: RecordingDetail) => void;
}) {
  const message = useMessages();
  return (
    <Card className="border-border bg-card">
      <CardContent className="px-3 py-2.5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-start space-x-2.5 min-w-0 flex-1">
            <Monitor className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" />
            <div className="min-w-0">
              <h3 id="recording-detail-label" className="text-sm font-medium text-foreground">Scroll capture</h3>
              <p id="recording-detail-description" className="text-xs text-muted-foreground mt-0.5">{message(descriptions[value])}</p>
              <p className="text-xs text-muted-foreground mt-1">Only scroll frequency changes. Image quality and text extraction per snapshot stay the same. Existing battery limits still apply.</p>
            </div>
          </div>
          <Select value={value} onValueChange={(next) => onChange(next as RecordingDetail)}>
            <SelectTrigger aria-labelledby="recording-detail-label" aria-describedby="recording-detail-description" className="w-[190px] h-8 text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">Auto</SelectItem>
              <SelectItem value="low_impact">Low impact</SelectItem>
              <SelectItem value="balanced">Balanced</SelectItem>
              <SelectItem value="more_detail">More detail</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </CardContent>
    </Card>
  );
}
