// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { useEffect, useRef, useState } from "react";
import { HardDrive, Loader2 } from "lucide-react";
import { useGT } from "gt-react";
import { useManagedPolicy } from "@/lib/hooks/use-managed-policy";
import { useSettings } from "@/lib/hooks/use-settings";
import { useStorageCapacity } from "@/lib/hooks/use-storage-capacity";
import { canRecommendMedia, gib } from "@/lib/storage/advice";
import { localFetch } from "@/lib/api";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from "@/components/ui/alert-dialog";

export function StorageAdviceCard() {
  const ui = useGT();
  const { settings, updateSettings } = useSettings();
  const { capacity, directory, loading, error, refresh } = useStorageCapacity();
  const policy = useManagedPolicy();
  const managed = [
    "localRetentionEnabled",
    "localRetentionMode",
    "localRetentionDays",
  ].some(policy.isSettingLocked);
  const canChange = policy.isManagedDeploymentResolved && !managed;
  const previousDirectory = useRef("");
  const [open, setOpen] = useState(false);
  const [preview, setPreview] = useState<{
    bytes: number;
    file_count: number;
  } | null>(null);
  const [previewError, setPreviewError] = useState(false);
  const [retry, setRetry] = useState(0);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState("");
  const [applied, setApplied] = useState(false);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (
      directory &&
      previousDirectory.current &&
      directory !== previousDirectory.current
    ) {
      setOpen(false);
      setApplied(false);
      setSaved(false);
    }
    if (directory) previousDirectory.current = directory;
  }, [directory]);
  useEffect(() => {
    if (managed) setOpen(false);
  }, [managed]);
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setPreview(null);
    setPreviewError(false);
    void localFetch("/data/storage-preview?older_than_days=7")
      .then(async (response) => {
        if (!response.ok) throw new Error("Preview unavailable");
        const data = await response.json();
        if (
          !Number.isFinite(data.bytes) ||
          data.bytes < 0 ||
          !Number.isFinite(data.file_count) ||
          data.file_count < 0
        )
          throw new Error("Invalid preview");
        if (!cancelled) setPreview(data);
      })
      .catch(() => {
        if (!cancelled) setPreviewError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [open, retry, directory]);

  const confirm = async () => {
    if (!preview || saving || !canChange || loading || error) return;
    setSaving(true);
    setSaveError("");
    let configured = applied;
    try {
      if (!configured) {
        const response = await localFetch("/retention/configure", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            enabled: true,
            mode: "media",
            retention_days: 7,
          }),
        });
        if (!response.ok) throw new Error("Configuration failed");
        configured = true;
        setApplied(true);
      }
      await updateSettings({
        localRetentionEnabled: true,
        localRetentionMode: "media",
        localRetentionDays: 7,
        storageRetentionDefaultDays: undefined,
      });
      setSaved(true);
      setApplied(false);
      setOpen(false);
      refresh();
    } catch {
      setSaveError(
        configured
          ? ui(
              "The 7-day policy is active, but app settings could not be saved. Retry saving to keep them in sync.",
            )
          : ui(
              "Could not confirm the policy change. Try again to apply the 7-day policy.",
            ),
      );
    } finally {
      setSaving(false);
    }
  };

  const shorter =
    canChange && capacity?.recommendedDays === 7 && canRecommendMedia(settings);
  const activeSeven =
    settings.localRetentionEnabled &&
    settings.localRetentionDays === 7 &&
    (settings.localRetentionMode ?? "media") === "media";
  return (
    <section
      className="rounded-lg border border-border bg-card p-4 space-y-4"
      aria-label={ui("Recording drive storage")}
    >
      <div className="flex items-start gap-3">
        <HardDrive className="h-5 w-5 shrink-0 mt-0.5 text-muted-foreground" />
        <div className="flex-1">
          <h3 className="text-sm font-medium">{ui("Recording drive")}</h3>
          <p className="text-xs text-muted-foreground mt-1">
            {ui(
              "Storage for your recordings, separate from device performance.",
            )}
          </p>
        </div>
        <Button variant="ghost" size="sm" disabled={loading} onClick={refresh}>
          {ui("Check again")}
        </Button>
      </div>
      {loading ? (
        <p role="status" className="text-sm text-muted-foreground">
          {ui("Checking storage...")}
        </p>
      ) : error || !capacity ? (
        <p role="status" className="text-sm text-muted-foreground">
          {ui(
            "Storage could not be checked. Your retention settings are unchanged.",
          )}
        </p>
      ) : (
        <>
          <dl className="grid grid-cols-2 gap-4">
            <div>
              <dt className="text-xs text-muted-foreground">
                {ui("Total capacity")}
              </dt>
              <dd className="text-xl mt-1">{gib(capacity.totalBytes)} GB</dd>
            </div>
            <div>
              <dt className="text-xs text-muted-foreground">
                {ui("Available now")}
              </dt>
              <dd className="text-xl mt-1">
                {gib(capacity.availableBytes)} GB{" "}
                <span className="text-xs text-muted-foreground">
                  (
                  {Math.round(
                    (capacity.availableBytes / capacity.totalBytes) * 100,
                  )}
                  %)
                </span>
              </dd>
            </div>
          </dl>
          <div className="flex flex-wrap gap-2 text-xs">
            {capacity.smallCapacity && (
              <span className="rounded border border-border px-2 py-1">
                {ui("Small drive")}
              </span>
            )}
            {capacity.lowSpace && (
              <span className="rounded border border-border px-2 py-1">
                {ui("Space running low")}
              </span>
            )}
            {!capacity.smallCapacity && !capacity.lowSpace && (
              <span className="text-muted-foreground">
                {ui("Room for recording")}
              </span>
            )}
          </div>
          {managed && (
            <p className="text-sm text-muted-foreground">
              {ui("Retention is managed by your organization.")}
            </p>
          )}
          {shorter && !activeSeven && (
            <div className="border-t border-border pt-4 space-y-3">
              <p className="text-sm font-medium">
                {ui("Suggested: keep 7 days of video and audio")}
              </p>
              <p className="text-sm text-muted-foreground">
                {ui(
                  "A shorter media history limits storage growth. Older clips are removed, while searchable text and transcripts stay.",
                )}
              </p>
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  size="sm"
                  onClick={() => {
                    setSaveError("");
                    setOpen(true);
                  }}
                >
                  {ui("Review 7-day policy")}
                </Button>
                <span className="text-xs text-muted-foreground">
                  {ui("Nothing changes until you confirm.")}
                </span>
              </div>
            </div>
          )}
          {activeSeven && (
            <div
              role="status"
              className="border-t border-border pt-3 space-y-1"
            >
              <p className="text-sm font-medium">
                {saved
                  ? ui("7-day media policy saved")
                  : ui("7-day media history is on")}
              </p>
              <p className="text-xs text-muted-foreground">
                {settings.storageRetentionDefaultDays === 7 && !saved
                  ? ui(
                      "Chosen at setup for this drive. Video and audio older than 7 days are removed. Searchable text stays.",
                    )
                  : ui(
                      "Video and audio older than 7 days will be removed. Searchable text stays. You can change this below.",
                    )}
              </p>
            </div>
          )}
          {capacity.lowSpace && (
            <p className="text-xs text-muted-foreground">
              {ui(
                "Retention limits Screenpipe's growth. Other files may still need cleanup, and space is not freed until cleanup runs.",
              )}
            </p>
          )}
        </>
      )}
      <AlertDialog
        open={open}
        onOpenChange={(value) => {
          if (!saving) setOpen(value);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {ui("Keep 7 days of video and audio?")}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {ui(
                "This replaces your current retention policy. Video, audio and screenshots older than 7 days will be permanently removed during cleanup, including existing recordings. Searchable text and transcripts stay. Deleted media cannot be recovered.",
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {preview ? (
            <p className="text-sm">
              {ui("Estimated older media: {count} files, {size} GB.", {
                count: preview.file_count,
                size: gib(preview.bytes),
              })}
            </p>
          ) : previewError ? (
            <div role="alert" className="text-sm space-y-2">
              <p>
                {ui(
                  "Could not preview older media. Retry before changing the policy.",
                )}
              </p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => setRetry((value) => value + 1)}
              >
                {ui("Retry preview")}
              </Button>
            </div>
          ) : (
            <p role="status" className="text-sm text-muted-foreground">
              {ui("Checking what will be removed...")}
            </p>
          )}
          {saveError && (
            <p role="alert" className="text-sm text-destructive">
              {saveError}
            </p>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={saving}>
              {applied ? ui("Close") : ui("Keep current policy")}
            </AlertDialogCancel>
            <Button
              disabled={!preview || saving || loading || error || !canChange}
              onClick={confirm}
            >
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {applied
                ? ui("Retry saving settings")
                : ui("Use 7-day media policy")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
