"use client";

import { Button } from "@/components/ui/button";
import { Sparkles, X } from "lucide-react";
import { create } from "zustand";
import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { relaunch } from "@tauri-apps/plugin-process";
import { commands } from "@/lib/utils/tauri";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { platform, arch } from "@tauri-apps/plugin-os";
import { useToast } from "@/components/ui/use-toast";
import { cn } from "@/lib/utils";
import { screenpipeWebUrl } from "@/lib/web-url";

interface UpdateInfo {
  version: string;
  body: string;
}

interface AuthRequiredInfo {
  version: string;
  message: string;
}

interface UpdateBannerState {
  isVisible: boolean;
  updateInfo: UpdateInfo | null;
  isInstalling: boolean;
  pendingUpdate: Update | null;
  authRequired: AuthRequiredInfo | null;
  // Version the user dismissed in this session. Periodic re-checks and
  // providers-remount hydration would otherwise re-show the same banner
  // immediately after the user clicked X.
  dismissedVersion: string | null;
  setIsVisible: (visible: boolean) => void;
  setUpdateInfo: (info: UpdateInfo | null) => void;
  setIsInstalling: (installing: boolean) => void;
  setPendingUpdate: (update: Update | null) => void;
  setAuthRequired: (info: AuthRequiredInfo | null) => void;
  dismiss: (version: string) => void;
  resetDismissed: () => void;
}

export const useUpdateBanner = create<UpdateBannerState>((set) => ({
  isVisible: false,
  updateInfo: null,
  isInstalling: false,
  pendingUpdate: null,
  authRequired: null,
  dismissedVersion: null,
  setIsVisible: (visible) => set({ isVisible: visible }),
  setUpdateInfo: (info) => set({ updateInfo: info }),
  setIsInstalling: (installing) => set({ isInstalling: installing }),
  setPendingUpdate: (update) => set({ pendingUpdate: update }),
  setAuthRequired: (info) => set({ authRequired: info }),
  dismiss: (version) => set({ isVisible: false, authRequired: null, dismissedVersion: version }),
  resetDismissed: () => set({ dismissedVersion: null }),
}));

interface UpdateBannerProps {
  className?: string;
  compact?: boolean;
  /** "sidebar" renders a vertical card sized for the app sidebar. */
  variant?: "default" | "sidebar";
}

async function getWindowsUpdateOptions() {
  const cpuArch = arch();
  const isEnterprise = await commands.isEnterpriseBuildCmd().catch(() => false);
  const channel = isEnterprise ? "enterprise" : "stable";
  const headers: Record<string, string> = {};

  if (isEnterprise) {
    const licenseKey = await commands.getEnterpriseLicenseKey().catch(() => null);
    if (licenseKey) {
      headers["X-License-Key"] = licenseKey;
    }
  }

  return {
    checkOptions: {
      endpoints: [
        screenpipeWebUrl(`/api/app-update/${channel}/windows-${cpuArch}/{{current_version}}`, "https://screenpipe.com"),
      ],
      ...(Object.keys(headers).length > 0 ? { headers } : {}),
    },
    downloadOptions: Object.keys(headers).length > 0 ? { headers } : undefined,
  };
}

export function UpdateBanner({ className, compact = false, variant = "default" }: UpdateBannerProps) {
  const { isVisible, updateInfo, isInstalling, setIsInstalling, pendingUpdate, authRequired, dismiss } = useUpdateBanner();
  const { toast } = useToast();

  const handleUpdate = async () => {
    setIsInstalling(true);
    const os = platform();

    try {
      // Windows: NSIS installer calls process::exit directly, bypassing our
      // ExitRequested handler — plain relaunch is fine. macOS/Linux go through
      // restart_for_update which sets QUIT_REQUESTED so the exit isn't blocked
      // by main.rs (2026-06-10 "stuck on still starting" report).
      if (os === "windows") {
        const gate = await commands.awaitSafeRestart(60);
        if (gate !== "proceed") {
          setIsInstalling(false);
          toast({
            title: "screenpipe is still starting up",
            description:
              gate === "errored"
                ? "startup error — open settings to see details before restarting"
                : "finish startup first, then click update again",
            variant: "destructive",
          });
          return;
        }
        toast({
          title: "downloading update...",
          description: "please wait while the update is downloaded",
          duration: Infinity,
        });

        // Stop screenpipe before update on Windows
        try {
          await commands.stopScreenpipe();
        } catch (e) {
          console.warn("failed to stop screenpipe:", e);
        }

        // Get or check for the update
        let update = pendingUpdate;
        const { checkOptions, downloadOptions } = await getWindowsUpdateOptions();
        if (!update) {
          update = await check(checkOptions as any);
        }

        if (update?.available) {


          await update.downloadAndInstall(undefined, downloadOptions);

          toast({
            title: "update complete",
            description: "relaunching application",
            duration: 3000,
          });
        }

        // Fallback relaunch only if installer didn't run (no update available
        // at click time); normal path: downloadAndInstall already exited.
        await relaunch();
      } else {
        // macOS/Linux: bundle already staged by backend. `restart_for_update`
        // gates internally, so no separate `awaitSafeRestart` call needed.
        toast({
          title: "installing update...",
          description: "screenpipe will restart automatically",
          duration: 10000,
        });
        const res = await commands.restartForUpdate(60);
        const outcome = res.status === "ok" ? res.data : "errored";
        if (outcome !== "proceed") {
          setIsInstalling(false);
          toast({
            title: "screenpipe is still starting up",
            description:
              outcome === "errored"
                ? "startup error — open settings to see details before restarting"
                : "finish startup first, then click update again",
            variant: "destructive",
          });
          return;
        }
        // restart scheduled off-thread; runtime will tear down shortly.
        // Leave button on "restarting…" until the process is replaced.
      }
    } catch (error) {
      console.error("failed to update:", error);
      setIsInstalling(false);
      toast({
        title: "update failed",
        description: "please try again or download manually",
        variant: "destructive",
      });
    }
  };

  // Show auth-required state — user needs to sign in to download updates
  if (authRequired) {
    if (compact) {
      return (
        <div className={cn("flex items-center gap-2 text-xs text-muted-foreground", className)}>
          <Sparkles className="h-3 w-3 text-primary" />
          <span>v{authRequired.version} available</span>
          <Button
            variant="ghost"
            size="sm"
            className="h-5 px-2 text-xs"
            onClick={() => window.location.href = "/home"}
          >
            sign in to update
          </Button>
        </div>
      );
    }
    return (
      <div className={cn(
        "flex items-center justify-between gap-3 px-3 py-2 bg-muted/50 border-b text-sm",
        className
      )}>
        <div className="flex items-center gap-2 flex-1">
          <Sparkles className="h-4 w-4 text-primary" />
          <span>
            screenpipe <span className="font-medium">v{authRequired.version}</span> is available — sign in to download
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="default"
            size="sm"
            className="h-7 px-3 text-xs"
            onClick={() => window.location.href = "/home"}
          >
            sign in
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={() => dismiss(authRequired.version)}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>
    );
  }

  if (!isVisible || !updateInfo) return null;

  if (variant === "sidebar") {
    return (
      <button
        type="button"
        data-testid="update-banner"
        onClick={handleUpdate}
        disabled={isInstalling}
        className={cn(
          "w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg border border-border bg-card/50 hover:bg-card transition-colors text-left disabled:opacity-60",
          className,
        )}
      >
        <Sparkles className="h-4 w-4 text-primary shrink-0" />
        <div className="flex-1 min-w-0">
          <div className="text-xs font-medium text-foreground truncate">
            {isInstalling ? "Restarting…" : "Restart to update"}
          </div>
          <div className="text-[10px] text-muted-foreground truncate">v{updateInfo.version}</div>
        </div>
      </button>
    );
  }

  if (compact) {
    return (
      <div className={cn(
        "flex items-center gap-2 text-xs text-muted-foreground",
        className
      )}>
        <Sparkles className="h-3 w-3 text-primary" />
        <span>v{updateInfo.version} ready</span>
        <Button
          variant="ghost"
          size="sm"
          className="h-5 px-2 text-xs"
          onClick={handleUpdate}
          disabled={isInstalling}
        >
          {isInstalling ? "restarting..." : "restart to update"}
        </Button>
      </div>
    );
  }

  return (
    <div className={cn(
      "flex items-center justify-between gap-3 px-3 py-2 bg-muted/50 border-b text-sm",
      className
    )}>
      <div className="flex items-center gap-2 flex-1">
        <Sparkles className="h-4 w-4 text-primary" />
        <span>
          screenpipe <span className="font-medium">v{updateInfo.version}</span> is ready
        </span>
      </div>
      <div className="flex items-center gap-2">
        <Button
          variant="default"
          size="sm"
          className="h-7 px-3 text-xs"
          onClick={handleUpdate}
          disabled={isInstalling}
        >
          {isInstalling ? "restarting..." : "restart to update"}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0"
          onClick={() => dismiss(updateInfo.version)}
        >
          <X className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

interface PendingUpdateSnapshot {
  version: string;
  body: string;
  downloaded: boolean;
  auth_required: boolean;
}

// Hook to listen for update events from Rust.
// Mounted globally in app/providers.tsx so it survives route changes and
// catches the `update-available` event regardless of which page is open
// when the download finishes. On mount, it also pulls the current pending
// state from Rust so it can recover if the event fired before this hook
// registered (boot-time webview race).
export function useUpdateListener() {
  const { setIsVisible, setUpdateInfo, setAuthRequired } = useUpdateBanner();

  useEffect(() => {
    let unlistenAvailable: (() => void) | undefined;
    let unlistenAuth: (() => void) | undefined;

    // Rust re-emits update-available on every periodic check, and providers
    // hydration runs on every remount — both would otherwise resurrect a
    // banner the user just dismissed. Read dismissedVersion fresh inside the
    // callback so a newer version still shows even if an older one is dismissed.
    const showIfNotDismissed = (info: UpdateInfo) => {
      setUpdateInfo(info);
      if (useUpdateBanner.getState().dismissedVersion !== info.version) {
        setIsVisible(true);
      }
    };
    const showAuthIfNotDismissed = (info: AuthRequiredInfo) => {
      if (useUpdateBanner.getState().dismissedVersion !== info.version) {
        setAuthRequired(info);
      }
    };

    const setupListeners = async () => {
      // Download happens silently in the background. Banner only appears
      // when the download is complete and the app is ready to restart.
      unlistenAvailable = await listen<UpdateInfo>("update-available", (event) => {
        showIfNotDismissed(event.payload);
      });

      // Listen for auth-required (user needs to sign in to download update)
      unlistenAuth = await listen<AuthRequiredInfo>("update-auth-required", (event) => {
        showAuthIfNotDismissed(event.payload);
      });

      // Hydrate from Rust in case the event fired before we mounted.
      try {
        const resPending = await commands.getPendingUpdate();
  const pending = resPending.status === "ok" ? resPending.data : null;
        if (pending) {
          if (pending.auth_required) {
            showAuthIfNotDismissed({ version: pending.version, message: "sign in to get the latest update" });
          } else if (pending.downloaded) {
            showIfNotDismissed({ version: pending.version, body: pending.body });
          }
        }
      } catch (e) {
        // Command not registered yet (older Rust side) or app not ready.
        // Fall back to event-driven path silently.
      }
    };

    setupListeners();

    return () => {
      unlistenAvailable?.();
      unlistenAuth?.();
    };
  }, [setIsVisible, setUpdateInfo, setAuthRequired]);
}
