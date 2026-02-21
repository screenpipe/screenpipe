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
import { useIsEnterpriseBuild } from "@/lib/hooks/use-is-enterprise-build";

interface UpdateInfo {
  version: string;
  body: string;
}

interface DownloadProgress {
  version: string;
  downloaded: number;
  total: number | null;
  percent: number;
}

interface AuthRequiredInfo {
  version: string;
  message: string;
}

interface UpdateBannerState {
  isVisible: boolean;
  updateInfo: UpdateInfo | null;
  isInstalling: boolean;
  isDownloading: boolean;
  downloadProgress: DownloadProgress | null;
  pendingUpdate: Update | null;
  authRequired: AuthRequiredInfo | null;
  setIsVisible: (visible: boolean) => void;
  setUpdateInfo: (info: UpdateInfo | null) => void;
  setIsInstalling: (installing: boolean) => void;
  setIsDownloading: (downloading: boolean) => void;
  setDownloadProgress: (progress: DownloadProgress | null) => void;
  setPendingUpdate: (update: Update | null) => void;
  setAuthRequired: (info: AuthRequiredInfo | null) => void;
}

export const useUpdateBanner = create<UpdateBannerState>((set) => ({
  isVisible: false,
  updateInfo: null,
  isInstalling: false,
  isDownloading: false,
  downloadProgress: null,
  pendingUpdate: null,
  authRequired: null,
  setIsVisible: (visible) => set({ isVisible: visible }),
  setUpdateInfo: (info) => set({ updateInfo: info }),
  setIsInstalling: (installing) => set({ isInstalling: installing }),
  setIsDownloading: (downloading) => set({ isDownloading: downloading }),
  setDownloadProgress: (progress) => set({ downloadProgress: progress }),
  setPendingUpdate: (update) => set({ pendingUpdate: update }),
  setAuthRequired: (info) => set({ authRequired: info }),
}));

interface UpdateBannerProps {
  className?: string;
  compact?: boolean;
}

export function UpdateBanner({ className, compact = false }: UpdateBannerProps) {
  const isEnterprise = useIsEnterpriseBuild();
  const { isVisible, updateInfo, isInstalling, isDownloading, downloadProgress, setIsVisible, setIsInstalling, pendingUpdate, authRequired, setAuthRequired } = useUpdateBanner();
  const { toast } = useToast();

  if (isEnterprise) return null;

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
            onClick={() => window.location.href = "/settings"}
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
            onClick={() => window.location.href = "/settings"}
          >
            sign in
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="h-7 w-7 p-0"
            onClick={() => setAuthRequired(null)}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      </div>
    );
  }

  // Show downloading state even before updateInfo is set
  if (isDownloading && !updateInfo) {
    const pct = downloadProgress?.percent ?? 0;
    if (compact) {
      return (
        <div className={cn("flex items-center gap-2 text-xs text-muted-foreground", className)}>
          <Sparkles className="h-3 w-3 text-primary animate-pulse" />
          <span>downloading update... {pct}%</span>
        </div>
      );
    }
    return (
      <div className={cn("flex items-center gap-3 px-3 py-2 bg-muted/50 border-b text-sm", className)}>
        <Sparkles className="h-4 w-4 text-primary animate-pulse" />
        <div className="flex items-center gap-2 flex-1">
          <span>downloading update{downloadProgress?.version ? ` v${downloadProgress.version}` : ""}...</span>
          <div className="flex-1 max-w-[200px] h-1.5 bg-muted rounded-full overflow-hidden">
            <div
              className="h-full bg-primary rounded-full transition-all duration-300"
              style={{ width: `${pct}%` }}
            />
          </div>
          <span className="text-xs text-muted-foreground">{pct}%</span>
        </div>
      </div>
    );
  }

  if (!isVisible || !updateInfo) return null;

  if (compact) {
    return (
      <div className={cn(
        "flex items-center gap-2 text-xs text-muted-foreground",
        className
      )}>
        <Sparkles className="h-3 w-3 text-primary" />
        {isDownloading ? (
          <>
            <span>downloading v{updateInfo.version}... {downloadProgress?.percent ?? 0}%</span>
          </>
        ) : (
          <>
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
          </>
        )}
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
        {isDownloading ? (
          <div className="flex items-center gap-2 flex-1">
            <span>downloading <span className="font-medium">v{updateInfo.version}</span></span>
            <div className="flex-1 max-w-[200px] h-1.5 bg-muted rounded-full overflow-hidden">
              <div
                className="h-full bg-primary rounded-full transition-all duration-300"
                style={{ width: `${downloadProgress?.percent ?? 0}%` }}
              />
            </div>
            <span className="text-xs text-muted-foreground">{downloadProgress?.percent ?? 0}%</span>
          </div>
        ) : (
          <span>
            screenpipe <span className="font-medium">v{updateInfo.version}</span> is ready
          </span>
        )}
      </div>
      {!isDownloading && (
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
            onClick={() => setIsVisible(false)}
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
      )}
    </div>
  );
}

// Hook to listen for update events from Rust
export function useUpdateListener() {
  const { setIsVisible, setUpdateInfo, setIsDownloading, setDownloadProgress, setAuthRequired } = useUpdateBanner();

  useEffect(() => {
    let unlistenAvailable: (() => void) | undefined;
    let unlistenClick: (() => void) | undefined;
    let unlistenDownloading: (() => void) | undefined;
    let unlistenProgress: (() => void) | undefined;
    let unlistenAuth: (() => void) | undefined;

    const setupListeners = async () => {
      // Listen for download starting (shows banner immediately)
      unlistenDownloading = await listen<{ version: string; body: string }>("update-downloading", (event) => {
        setIsDownloading(true);
        setDownloadProgress({ version: event.payload.version, downloaded: 0, total: null, percent: 0 });
        setIsVisible(true);
      });

      // Listen for download progress
      unlistenProgress = await listen<DownloadProgress>("update-download-progress", (event) => {
        setDownloadProgress(event.payload);
      });

      // Listen for update ready (download complete)
      unlistenAvailable = await listen<UpdateInfo>("update-available", (event) => {
        setIsDownloading(false);
        setDownloadProgress(null);
        setUpdateInfo(event.payload);
        setIsVisible(true);
      });

      // Listen for tray menu click
      unlistenClick = await listen("update-now-clicked", () => {
        setIsVisible(true);
      });

      // Listen for auth-required (user needs to sign in to download update)
      unlistenAuth = await listen<AuthRequiredInfo>("update-auth-required", (event) => {
        setAuthRequired(event.payload);
        setIsDownloading(false);
        setDownloadProgress(null);
      });
    };

    setupListeners();

    return () => {
      unlistenAvailable?.();
      unlistenClick?.();
      unlistenDownloading?.();
      unlistenProgress?.();
      unlistenAuth?.();
    };
  }, [setIsVisible, setUpdateInfo, setIsDownloading, setDownloadProgress, setAuthRequired]);
}
