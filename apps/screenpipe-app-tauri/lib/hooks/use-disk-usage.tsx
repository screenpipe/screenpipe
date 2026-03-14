"use client";

import { useState, useEffect } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useSettings } from "@/lib/hooks/use-settings";

export interface MonitorUsage {
  name: string;
  size: string;
  size_bytes: number;
}

export interface DiskUsedByMedia {
  videos_size: string;
  audios_size: string;
  total_media_size: string;
  monitors: MonitorUsage[];
}

export interface DiskUsedByOther {
  database_size: string;
  logs_size: string;
}

export interface DiskUsage {
  media: DiskUsedByMedia;
  other: DiskUsedByOther;
  total_data_size: string;
  total_cache_size: string;
  available_space: string;
  recording_since: string | null;
  total_data_bytes: number;
  available_space_bytes: number;
  /** Actual cache directory path from dirs::cache_dir. Platform-specific (Linux/macOS/Windows). */
  cache_dir_path?: string | null;
  /** Mount point of disk containing this dir. For same-disk detection when custom dir set. */
  disk_mount_point?: string | null;
}

export type DirUsage = { path: string; usage: DiskUsage };

export function useDiskUsage() {
  const { getCurrentDataDir, getDefaultDataDir, isSettingsLoaded, settings } = useSettings();
  const [defaultUsage, setDefaultUsage] = useState<DirUsage | null>(null);
  const [customUsage, setCustomUsage] = useState<DirUsage | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const hasCustomDir =
    settings.dataDir && settings.dataDir !== "default" && settings.dataDir !== "";

  const fetchDiskUsage = async (forceRefresh: boolean = false) => {
    try {
      setIsLoading(true);
      setError(null);

      const defaultPath = await getDefaultDataDir();

      if (hasCustomDir) {
        const customPath = await getCurrentDataDir();
        const [defaultResult, customResult] = await Promise.all([
          invoke<DiskUsage>("get_disk_usage", { forceRefresh, dataDir: defaultPath }),
          invoke<DiskUsage>("get_disk_usage", { forceRefresh, dataDir: customPath }),
          new Promise(resolve => setTimeout(resolve, forceRefresh ? 300 : 500))
        ]);
        setDefaultUsage({ path: defaultPath, usage: defaultResult });
        setCustomUsage({ path: customPath, usage: customResult });
      } else {
        const [result] = await Promise.all([
          invoke<DiskUsage>("get_disk_usage", { forceRefresh, dataDir: defaultPath }),
          new Promise(resolve => setTimeout(resolve, forceRefresh ? 300 : 500))
        ]);
        setDefaultUsage({ path: defaultPath, usage: result });
        setCustomUsage(null);
      }
    } catch (err) {
      console.error("Failed to fetch disk usage:", err);
      
      // Provide more user-friendly error messages
      let errorMessage = "Unknown error occurred";
      if (typeof err === "string") {
        errorMessage = err;
      } else if (err instanceof Error) {
        errorMessage = err.message;
      } else if (err && typeof err === "object" && "message" in err) {
        errorMessage = String(err.message);
      }
      
      // Handle common error scenarios
      if (errorMessage.includes("permission") || errorMessage.includes("access")) {
        errorMessage = "Permission denied. Please check file access permissions.";
      } else if (errorMessage.includes("not found") || errorMessage.includes("directory")) {
        errorMessage = "Screenpipe data directory not found. Make sure Screenpipe has been initialized.";
      } else if (errorMessage.includes("timeout")) {
        errorMessage = "Calculation timed out. Try again or check for very large datasets.";
      }
      
      setError(errorMessage);
    } finally {
      setIsLoading(false);
    }
  };

  // Refetch when settings load (dataDir may have been custom) or when dataDir changes
  useEffect(() => {
    if (!isSettingsLoaded) return;
    fetchDiskUsage();
  }, [isSettingsLoaded, settings.dataDir]);

  return {
    defaultUsage,
    customUsage,
    hasCustomDir,
    isLoading,
    error,
    refetch: () => fetchDiskUsage(true),
  };
} 