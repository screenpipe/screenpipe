// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";

import React from "react";
import { useGT } from "gt-react";
import { EyeOff } from "lucide-react";
import { useSettings } from "@/lib/hooks/use-settings";
import { useManagedPolicy } from "@/lib/hooks/use-managed-policy";
import { commands } from "@/lib/utils/tauri";
import { ManagedSwitch } from "@/components/enterprise-locked-setting";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useToast } from "@/components/ui/use-toast";

export function TimelineSetting() {
  const gt = useGT();
  const { settings, updateSettings } = useSettings();
  const { isSettingLocked, getManagedValue } = useManagedPolicy();
  const { toast } = useToast();
  const [confirmOpen, setConfirmOpen] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const inFlight = React.useRef(false);
  const managedScreenshots = getManagedValue("disableScreenshots");
  const managedVision = getManagedValue("disableVision");
  const screenshotsDisabled = managedScreenshots === undefined
    ? settings.disableScreenshots ?? false : managedScreenshots === "true";
  const visionDisabled = managedVision === undefined
    ? settings.disableVision ?? false : managedVision === "true";
  const captureOff = screenshotsDisabled || visionDisabled;
  const canRestoreScreenshots = screenshotsDisabled && !visionDisabled &&
    !isSettingLocked("disableScreenshots") && !isSettingLocked("screen_recording");

  const apply = async (enabled: boolean, restoreScreenshots = false) => {
    // Re-check current policy at the action boundary, including a dialog that
    // remained open while organization policy changed.
    if (inFlight.current || isSettingLocked("disableTimeline") ||
      (restoreScreenshots && !canRestoreScreenshots)) return;
    inFlight.current = true;
    setPending(true);
    setError(null);
    try {
      try {
        // Onboarding disables both flags. Restore capture only when the user
        // explicitly chooses it; timeline-only still supports existing history.
        await updateSettings({
          disableTimeline: !enabled,
          ...(restoreScreenshots ? { disableScreenshots: false } : {}),
        });
      } catch {
        setError(gt("Couldn't save the change. Try again."));
        return;
      }
      setConfirmOpen(false);
      try {
        if (enabled) await commands.showShortcutReminder(settings.showScreenpipeShortcut);
        else await commands.hideShortcutReminder();
      } catch {}
      try {
        const stopped = await commands.stopScreenpipe();
        if (stopped.status === "error") throw new Error(stopped.error);
        await new Promise((resolve) => setTimeout(resolve, 500));
        const started = await commands.spawnScreenpipe(null);
        if (started.status === "error") throw new Error(started.error);
        toast({
          title: enabled ? gt("Timeline enabled") : gt("Timeline disabled"),
          description: gt("Screenpipe restarted to apply the change."),
        });
      } catch {
        toast({
          title: gt("Failed to restart screenpipe"),
          description: gt("Your settings were saved. Restart screenpipe manually to apply them."),
          variant: "destructive",
        });
      }
    } finally {
      inFlight.current = false;
      setPending(false);
    }
  };

  const captureExplanation = visionDisabled
    ? gt("Screen context capture is off. Enable it in Screen settings to record new screenshots.")
    : isSettingLocked("disableScreenshots") || isSettingLocked("screen_recording")
      ? gt("Your organization controls screenshot capture. New screenshots are currently off.")
      : gt("Screenshot capture is off. The timeline can show existing history, but new screenshots won't be recorded.");

  return (
    <>
      <Card className="border-border bg-card">
        <CardContent className="px-3 py-2.5 space-y-2">
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center space-x-2.5">
              <EyeOff className="h-4 w-4 text-muted-foreground shrink-0" />
              <div>
                <h3 id="timeline-setting-label" className="text-sm font-medium text-foreground">Timeline / rewind</h3>
                <p className="text-xs text-muted-foreground">Browse your visual history. Restarts Screenpipe to apply.</p>
              </div>
            </div>
            <ManagedSwitch
              settingKey="disableTimeline"
              id="disableTimeline"
              aria-labelledby="timeline-setting-label"
              checked={!(settings.disableTimeline ?? false)}
              disabled={pending}
              onCheckedChange={(enabled) => {
                if (inFlight.current) return;
                setError(null);
                if (enabled && captureOff) setConfirmOpen(true);
                else void apply(enabled);
              }}
            />
          </div>
          {!settings.disableTimeline && captureOff && (
            <div className="ml-[26px] space-y-2">
              <p className="text-xs text-muted-foreground">{captureExplanation}</p>
              {canRestoreScreenshots && !isSettingLocked("disableTimeline") && (
                <Button size="sm" variant="outline" disabled={pending} onClick={() => setConfirmOpen(true)}>
                  Enable screenshot capture
                </Button>
              )}
            </div>
          )}
          {error && !confirmOpen && <p role="alert" className="text-xs text-destructive">{error}</p>}
        </CardContent>
      </Card>
      <Dialog open={confirmOpen} onOpenChange={(open) => { if (!inFlight.current) setConfirmOpen(open); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Enable timeline</DialogTitle>
            <DialogDescription>
              {captureExplanation}
              {canRestoreScreenshots && " "}
              {canRestoreScreenshots && gt("Enable screenshot capture to record new visual history. This uses more memory, CPU and disk.")}
            </DialogDescription>
          </DialogHeader>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          <div className="flex flex-col gap-2">
            {canRestoreScreenshots && (
              <Button disabled={pending || isSettingLocked("disableTimeline")} onClick={() => void apply(true, true)}>
                Enable timeline and screenshots
              </Button>
            )}
            <Button variant="outline" disabled={pending || isSettingLocked("disableTimeline")} onClick={() => void apply(true)}>
              Use existing history only
            </Button>
            <Button variant="ghost" disabled={pending} onClick={() => setConfirmOpen(false)}>Cancel</Button>
          </div>
        </DialogContent>
      </Dialog>
    </>
  );
}
