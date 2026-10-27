// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

"use client";

import { ArrowUpRight, X } from "lucide-react";
import { useState } from "react";
import { useGT } from "gt-react";
import { AnnouncementKindChip } from "@/components/announcement-kind-chip";
import type { Announcement } from "@/lib/announcements";

/** A persistent, opt-in sidebar promotion. Only the separate X dismisses it. */
export function AnnouncementSidebarCard({
  announcement,
  onOpen,
  onDismiss,
}: {
  announcement: Announcement;
  onOpen: () => void;
  onDismiss: () => void;
}) {
  const ui = useGT();
  const [failedImage, setFailedImage] = useState<string | null>(null);
  const image = announcement.image;
  const showImage = image && failedImage !== image.url;
  return (
    <div
      data-testid="announcement-sidebar-card"
      className="relative mb-3 overflow-hidden rounded-lg border border-border bg-background"
    >
      <button
        type="button"
        onClick={onOpen}
        aria-label={announcement.cta?.label ?? ui("Read announcement: {title}", { title: announcement.title })}
        className="block max-h-[35vh] w-full overflow-y-auto p-3 text-left transition-colors duration-150 hover:bg-muted/50 focus-visible:outline focus-visible:outline-1 focus-visible:-outline-offset-4 focus-visible:outline-foreground"
      >
        {showImage && (
          // Plain img preserves the remote image URL in the static desktop export.
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={image.url}
            alt={image.alt}
            referrerPolicy="no-referrer"
            onError={() => setFailedImage(image.url)}
            className="mb-3 aspect-video w-full rounded-md bg-muted object-cover"
          />
        )}
        <div className="pr-7">
          <AnnouncementKindChip kind={announcement.kind} />
        </div>
        <div className="mt-2 break-words pr-5 font-sans text-sm font-medium leading-snug">
          {announcement.title}
        </div>
        <div className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
          <span className="min-w-0 break-words">{announcement.cta?.label ?? ui("Learn more")}</span>
          <ArrowUpRight className="h-3.5 w-3.5 shrink-0" aria-hidden />
        </div>
      </button>
      <button
        type="button"
        onClick={onDismiss}
        aria-label={ui("Dismiss announcement")}
        className="absolute right-1 top-1 flex h-7 w-7 items-center justify-center rounded-md border border-border bg-background text-muted-foreground transition-colors duration-150 hover:bg-foreground hover:text-background focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-foreground"
      >
        <X className="h-3.5 w-3.5" aria-hidden />
      </button>
    </div>
  );
}
