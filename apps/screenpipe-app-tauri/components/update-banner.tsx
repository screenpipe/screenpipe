"use client";

import { Button } from "@/components/ui/button";
import { Sparkles, X } from "lucide-react";
import { create } from "zustand";
import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { relaunch } from "@tauri-apps/plugin-process";
import { invoke } from "@tauri-apps/api/core";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { platform, arch } from "@tauri-apps/plugin-os";
import { useToast } from "@/components/ui/use-toast";
import { cn } from "@/lib/utils";

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

export function UpdateBanner({ className, compact = false, variant = "default" }: UpdateBannerProps) {
  const { isVisible, updateInfo, isInstalling, setIsInstalling, pendingUpdate, authRequired, dismiss } = useUpdateBanner();
  const { toast } = useToast();

  const handleUpdate = async () => {
    setIsInstalling(true);
    const os = platform();

    try {
      // On Windows, the update is not pre-downloaded by the backend (unlike macOS/Linux)
      // We need to check for update, download, and install it before relaunching
      if (os === "windows") {
        toast({
          title: "downloading update...",
          description: "please wait while the update is downloaded",
          duration: Infinity,
        });

        // Stop screenpipe before update on Windows
        try {
          await invoke("stop_screenpipe");
        } catch (e) {
          console.warn("failed to stop screenpipe:", e);
        }

        // Get or check for the update
        let update = pendingUpdate;
        if (!update) {
          const cpuArch = arch();
          update = await check({ endpoints: [
            `https://screenpi.pe/api/app-update/stable/windows-${cpuArch}/{{current_version}}`,
          ] } as any);
        }

        if (update?.available) {


          await update.downloadAndInstall();

          toast({
            title: "update complete",
            description: "relaunching application",
            duration: 3000,
          });
        }
      } else {
        // On macOS/Linux, the update was already downloaded by the backend
        toast({
          title: "installing update...",
          description: "screenpipe will restart automatically",
          duration: 10000,
        });
      }

      await relaunch();
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
  const { setIsVisible, setUpdateInfo, setAuthRequired, resetDismissed } = useUpdateBanner();

  useEffect(() => {
    let unlistenAvailable: (() => void) | undefined;
    let unlistenClick: (() => void) | undefined;
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

      // Tray click is an explicit user request — clear any prior dismissal
      // so the banner reappears even if they X'd it earlier this session.
      unlistenClick = await listen("update-now-clicked", () => {
        resetDismissed();
        setIsVisible(true);
      });

      // Listen for auth-required (user needs to sign in to download update)
      unlistenAuth = await listen<AuthRequiredInfo>("update-auth-required", (event) => {
        showAuthIfNotDismissed(event.payload);
      });

      // Hydrate from Rust in case the event fired before we mounted.
      try {
        const pending = await invoke<PendingUpdateSnapshot | null>("get_pending_update");
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
      unlistenClick?.();
      unlistenAuth?.();
    };
  }, [setIsVisible, setUpdateInfo, setAuthRequired, resetDismissed]);
}
