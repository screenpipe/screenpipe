// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

/** Compact source identity; unfamiliar platforms keep their readable name. */
export function MeetingAppLabel({ app }: { app: string | null | undefined }) {
  const normalized = (app ?? "").trim().toLowerCase();
  if (!normalized || normalized === "manual") return null;
  const isGoogleMeet = ["google meet", "google-meet", "meet.google.com"].includes(
    normalized,
  );

  return (
    <>
      <span aria-hidden>·</span>
      {isGoogleMeet ? (
        <TooltipProvider delayDuration={250}>
          <Tooltip>
            <TooltipTrigger asChild>
              <span
                role="img"
                aria-label="Google Meet"
                tabIndex={0}
                className="inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-foreground"
              >
                {/* Bundled locally so opening a meeting makes no logo request. */}
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src="/images/google-meet.png"
                  alt=""
                  aria-hidden="true"
                  className="h-5 w-5 object-contain"
                />
              </span>
            </TooltipTrigger>
            <TooltipContent>Google Meet</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : (
        <span>{app}</span>
      )}
    </>
  );
}
