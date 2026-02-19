"use client";

import React, { useState, useEffect, useCallback } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  FolderOpen,
  RefreshCw,
  Check,
  Loader2,
  AlertCircle,
  Clock,
  ExternalLink,
  X,
} from "lucide-react";

// Official Obsidian logo SVG
const ObsidianLogo = ({ className }: { className?: string }) => (
  <svg
    viewBox="0 0 65 100"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
    className={className}
  >
    <path
      d="M46.3815 1.64838C45.2519 0.813498 43.7845 0.584108 42.4545 1.03483L3.24014 14.5801C1.49498 15.1697 0.326172 16.8207 0.326172 18.6635V62.5907C0.326172 63.9128 0.939877 65.1578 1.98099 65.9521L19.3133 79.1764L43.8598 98.2123C44.8174 98.9549 46.0419 99.2481 47.2303 99.0186L61.4684 96.1592C63.2723 95.7962 64.6211 94.2257 64.6738 92.3817L65.3262 28.3912C65.3519 26.2187 64.0954 24.2459 62.1038 23.3874L46.3815 1.64838Z"
      fill="url(#paint0_linear)"
    />
    <path
      d="M46.3815 1.64838C45.2519 0.813498 43.7845 0.584108 42.4545 1.03483L3.24014 14.5801C1.49498 15.1697 0.326172 16.8207 0.326172 18.6635V62.5907C0.326172 63.9128 0.939877 65.1578 1.98099 65.9521L19.3133 79.1764L43.8598 98.2123C44.8174 98.9549 46.0419 99.2481 47.2303 99.0186L61.4684 96.1592C63.2723 95.7962 64.6211 94.2257 64.6738 92.3817L65.3262 28.3912C65.3519 26.2187 64.0954 24.2459 62.1038 23.3874L46.3815 1.64838Z"
      fill="url(#paint1_radial)"
      fillOpacity="0.5"
    />
    <path
      d="M19.5464 79.4006L2.03852 65.7962C1.05533 65.0455 0.475586 63.8721 0.475586 62.6279V18.5625C0.475586 16.6254 1.74092 14.913 3.60033 14.3312L42.4771 1.03483C43.7845 0.584108 45.2519 0.813498 46.3815 1.64838L62.1038 23.3874C64.0954 24.2459 65.3519 26.2187 65.3262 28.3912L64.6738 92.3817C64.6211 94.2257 63.2723 95.7962 61.4684 96.1592L47.2303 99.0186C46.0419 99.2481 44.8174 98.9549 43.8598 98.2123L19.5464 79.4006Z"
      stroke="url(#paint2_linear)"
      strokeWidth="0.5"
    />
    <path
      d="M39.0728 36.9812L25.2818 62.8318C24.6506 63.9804 25.0839 65.4298 26.2325 66.061L43.2024 75.7139C44.3509 76.3451 45.8004 75.9118 46.4316 74.7632L60.2226 48.9126C60.8538 47.764 60.4205 46.3146 59.2719 45.6834L42.302 36.0305C41.1534 35.3993 39.704 35.8326 39.0728 36.9812Z"
      fill="#9A8AFF"
    />
    <path
      d="M19.3133 79.1764L1.98099 65.9521C0.939877 65.1578 0.326172 63.9128 0.326172 62.5907V18.6635L24.4687 63.6587L19.3133 79.1764Z"
      fill="url(#paint3_linear)"
    />
    <path
      d="M24.4687 63.6587L0.326172 18.6635C0.326172 16.8207 1.49498 15.1697 3.24014 14.5801L42.4545 1.03483L24.4687 63.6587Z"
      fill="url(#paint4_linear)"
    />
    <path
      d="M42.4545 1.03483L46.3815 1.64838L62.1038 23.3874L24.4687 63.6587L42.4545 1.03483Z"
      fill="url(#paint5_linear)"
    />
    <path
      d="M62.1038 23.3874C64.0954 24.2459 65.3519 26.2187 65.3262 28.3912L64.6738 92.3817L24.4687 63.6587L62.1038 23.3874Z"
      fill="url(#paint6_linear)"
    />
    <path
      d="M64.6738 92.3817C64.6211 94.2257 63.2723 95.7962 61.4684 96.1592L47.2303 99.0186C46.0419 99.2481 44.8174 98.9549 43.8598 98.2123L19.3133 79.1764L24.4687 63.6587L64.6738 92.3817Z"
      fill="url(#paint7_linear)"
    />
    <defs>
      <linearGradient id="paint0_linear" x1="32.8262" y1="0.695312" x2="32.8262" y2="99.1953" gradientUnits="userSpaceOnUse">
        <stop stopColor="#6C56CC"/>
        <stop offset="1" stopColor="#9785E5"/>
      </linearGradient>
      <radialGradient id="paint1_radial" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(32.8262 49.9453) scale(49.1504 49.1504)">
        <stop stopColor="white"/>
        <stop offset="1" stopColor="white" stopOpacity="0"/>
      </radialGradient>
      <linearGradient id="paint2_linear" x1="0.225586" y1="49.9453" x2="65.5762" y2="49.9453" gradientUnits="userSpaceOnUse">
        <stop stopColor="#6C56CC"/>
        <stop offset="1" stopColor="#9785E5"/>
      </linearGradient>
      <linearGradient id="paint3_linear" x1="12.3974" y1="18.6635" x2="12.3974" y2="79.1764" gradientUnits="userSpaceOnUse">
        <stop stopColor="#6C56CC"/>
        <stop offset="1" stopColor="#4A3A9E"/>
      </linearGradient>
      <linearGradient id="paint4_linear" x1="21.3903" y1="1.03483" x2="21.3903" y2="63.6587" gradientUnits="userSpaceOnUse">
        <stop stopColor="#9785E5"/>
        <stop offset="1" stopColor="#6C56CC"/>
      </linearGradient>
      <linearGradient id="paint5_linear" x1="43.2862" y1="1.03483" x2="43.2862" y2="63.6587" gradientUnits="userSpaceOnUse">
        <stop stopColor="#6C56CC"/>
        <stop offset="1" stopColor="#4A3A9E"/>
      </linearGradient>
      <linearGradient id="paint6_linear" x1="44.8974" y1="23.3874" x2="44.8974" y2="92.3817" gradientUnits="userSpaceOnUse">
        <stop stopColor="#9785E5"/>
        <stop offset="1" stopColor="#6C56CC"/>
      </linearGradient>
      <linearGradient id="paint7_linear" x1="42.0" y1="63.6587" x2="42.0" y2="99.1953" gradientUnits="userSpaceOnUse">
        <stop stopColor="#6C56CC"/>
        <stop offset="1" stopColor="#4A3A9E"/>
      </linearGradient>
    </defs>
  </svg>
);
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { Command } from "@tauri-apps/plugin-shell";
import { Badge } from "@/components/ui/badge";
import { useSettings } from "@/lib/hooks/use-settings";
import { useToast } from "@/components/ui/use-toast";

// Types matching Rust structs
interface ObsidianSyncSettings {
  enabled: boolean;
  vaultPath: string;
  notesPath: string; // Subfolder within vault for notes (e.g., "screenpipe/logs" or "daily/activity")
  syncIntervalMinutes: number;
  customPrompt: string;
  lastSyncTime: string | null;
  syncHours: number;
}

interface ObsidianSyncStatus {
  isSyncing: boolean;
  lastSyncTime: string | null;
  lastError: string | null;
  notesCreatedToday: number;
  nextScheduledRun: string | null;
}

interface SyncHistoryEntry {
  timestamp: string;
  status: "success" | "error";
  error?: string;
}

const userTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone; // e.g. "America/New_York"

const DEFAULT_CUSTOM_PROMPT = `timezone: ${userTimezone}
focus areas: work, coding, meetings
my projects: [[Project A]], [[Project B]]
embed video clips for meetings using absolute file paths
tag people I talk to frequently: [[Alice]], [[Bob]]`;

const DEFAULT_SETTINGS: ObsidianSyncSettings = {
  enabled: false,
  vaultPath: "",
  notesPath: "screenpipe/logs", // Default subfolder
  syncIntervalMinutes: 0, // 0 = manual only
  customPrompt: DEFAULT_CUSTOM_PROMPT,
  lastSyncTime: null,
  syncHours: 2,
};

export function ObsidianSyncCard() {
  const { settings: appSettings } = useSettings();
  const { toast } = useToast();

  const [settings, setSettings] = useState<ObsidianSyncSettings>(DEFAULT_SETTINGS);
  const [status, setStatus] = useState<ObsidianSyncStatus>({
    isSyncing: false,
    lastSyncTime: null,
    lastError: null,
    notesCreatedToday: 0,
    nextScheduledRun: null,
  });
  const [suggestedPaths, setSuggestedPaths] = useState<string[]>([]);
  const [isValidVault, setIsValidVault] = useState<boolean | null>(null);
  const [isValidating, setIsValidating] = useState(false);
  const [isExpanded, setIsExpanded] = useState(false);
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [syncHistory, setSyncHistory] = useState<SyncHistoryEntry[]>([]);

  // Load settings from localStorage on mount
  useEffect(() => {
    let saved: string | null = null;
    try { saved = localStorage?.getItem("obsidian-sync-settings"); } catch {}
    if (saved) {
      try {
        const parsed = JSON.parse(saved);
        // Preserve pre-filled custom prompt for existing users who never set one
        if (!parsed.customPrompt) {
          parsed.customPrompt = DEFAULT_CUSTOM_PROMPT;
        }
        setSettings({ ...DEFAULT_SETTINGS, ...parsed });
      } catch (e) {
        console.error("Failed to parse obsidian settings:", e);
      }
    }
    setSettingsLoaded(true);

    // Load sync history
    let savedHistory: string | null = null;
    try { savedHistory = localStorage?.getItem("obsidian-sync-history"); } catch {}
    if (savedHistory) {
      try {
        setSyncHistory(JSON.parse(savedHistory).slice(0, 10)); // Keep last 10
      } catch (e) {
        console.error("Failed to parse sync history:", e);
      }
    }

    // Fetch suggested vault paths
    fetchVaultPaths();

    // Get initial status
    fetchStatus();
  }, []);

  // Periodically refresh status to update "next run" countdown
  useEffect(() => {
    if (!settings.enabled) return;
    
    const interval = setInterval(() => {
      fetchStatus();
    }, 30000); // Refresh every 30 seconds
    
    return () => clearInterval(interval);
  }, [settings.enabled]);

  // Save settings to localStorage immediately
  useEffect(() => {
    if (settingsLoaded) {
      try { localStorage?.setItem("obsidian-sync-settings", JSON.stringify(settings)); } catch {}
    }
  }, [settings, settingsLoaded]);

  // Debounced save to Rust store (just persist, don't restart scheduler)
  useEffect(() => {
    if (!settingsLoaded) return;

    const timeoutId = setTimeout(() => {
      // Save to Rust store for persistence across app restarts
      invoke("obsidian_save_settings", { settings }).catch((e) => {
        console.error("Failed to save obsidian settings to store:", e);
      });
    }, 1000); // 1 second debounce

    return () => clearTimeout(timeoutId);
  }, [settings, settingsLoaded]);

  // Only restart scheduler when interval changes via user action (not on initial load)
  const prevIntervalRef = React.useRef<number | null>(null);
  const prevEnabledRef = React.useRef<boolean | null>(null);
  const isInitialLoadRef = React.useRef(true);
  
  useEffect(() => {
    if (!settingsLoaded) return;
    
    // Skip the first render after settings are loaded from localStorage
    // to avoid killing the auto-started scheduler from Rust
    if (isInitialLoadRef.current) {
      isInitialLoadRef.current = false;
      prevIntervalRef.current = settings.syncIntervalMinutes;
      prevEnabledRef.current = settings.enabled;
      return;
    }
    
    const intervalChanged = prevIntervalRef.current !== settings.syncIntervalMinutes;
    const enabledChanged = prevEnabledRef.current !== settings.enabled;
    
    prevIntervalRef.current = settings.syncIntervalMinutes;
    prevEnabledRef.current = settings.enabled;
    
    // Only restart if interval or enabled status changed by user action
    if ((intervalChanged || enabledChanged) && settings.enabled && settings.vaultPath && settings.syncIntervalMinutes > 0 && appSettings?.user?.token) {
      invoke("obsidian_start_scheduler", { 
        settings, 
        userToken: appSettings.user.token 
      }).catch((e) => {
        console.error("Failed to restart scheduler:", e);
      });
    }
  }, [settings.syncIntervalMinutes, settings.enabled, settingsLoaded, isValidVault, appSettings?.user?.token]);

  // Validate vault path when it changes
  useEffect(() => {
    if (settings.vaultPath) {
      validateVault(settings.vaultPath);
    } else {
      setIsValidVault(null);
    }
  }, [settings.vaultPath]);

  // Listen for sync events
  useEffect(() => {
    const unlisteners: (() => void)[] = [];

    listen<void>("obsidian_sync_started", () => {
      setStatus((s) => ({ ...s, isSyncing: true }));
    }).then((u) => unlisteners.push(u));

    listen<ObsidianSyncStatus>("obsidian_sync_completed", (event) => {
      setStatus(event.payload);
      // Add to history
      const newEntry: SyncHistoryEntry = { timestamp: new Date().toISOString(), status: "success" };
      setSyncHistory(prev => {
        const updated = [newEntry, ...prev].slice(0, 10);
        try { localStorage?.setItem("obsidian-sync-history", JSON.stringify(updated)); } catch {}
        return updated;
      });
      toast({
        title: "Obsidian sync completed",
        description: "Your activity has been synced to Obsidian",
      });
    }).then((u) => unlisteners.push(u));

    listen<string>("obsidian_sync_error", (event) => {
      setStatus((s) => ({
        ...s,
        isSyncing: false,
        lastError: event.payload,
      }));
      // Add to history
      const newEntry: SyncHistoryEntry = { timestamp: new Date().toISOString(), status: "error", error: event.payload };
      setSyncHistory(prev => {
        const updated = [newEntry, ...prev].slice(0, 10);
        try { localStorage?.setItem("obsidian-sync-history", JSON.stringify(updated)); } catch {}
        return updated;
      });
      toast({
        variant: "destructive",
        title: "Obsidian sync failed",
        description: event.payload,
      });
    }).then((u) => unlisteners.push(u));

    return () => {
      unlisteners.forEach((u) => u());
    };
  }, [toast]);

  const fetchVaultPaths = async () => {
    try {
      const paths = await invoke<string[]>("obsidian_get_vault_paths");
      setSuggestedPaths(paths);
    } catch (e) {
      console.error("Failed to fetch vault paths:", e);
    }
  };

  const fetchStatus = async () => {
    try {
      const status = await invoke<ObsidianSyncStatus>("obsidian_get_sync_status");
      setStatus(status);
    } catch (e) {
      console.error("Failed to fetch sync status:", e);
    }
  };

  const validateVault = useCallback(async (path: string) => {
    if (!path.trim()) {
      setIsValidVault(null);
      return;
    }

    setIsValidating(true);
    try {
      const isValid = await invoke<boolean>("obsidian_validate_vault", { path });
      setIsValidVault(isValid);
    } catch (e) {
      console.error("Failed to validate vault:", e);
      setIsValidVault(false);
    } finally {
      setIsValidating(false);
    }
  }, []);

  const handleBrowse = async () => {
    try {
      const selected = await openDialog({
        directory: true,
        multiple: false,
        title: "Select Notes Folder",
      });
      if (selected && typeof selected === "string") {
        setSettings((s) => ({ ...s, vaultPath: selected }));
      }
    } catch (e) {
      console.error("Failed to open dialog:", e);
    }
  };

  const handleSync = async () => {
    if (!settings.vaultPath) {
      toast({
        variant: "destructive",
        title: "No folder selected",
        description: "Please select a folder first",
      });
      return;
    }

    // Check if user is logged in (required for Claude API)
    if (!appSettings?.user?.token) {
      toast({
        variant: "destructive",
        title: "Login required",
        description: "Please log in to use Obsidian sync",
      });
      return;
    }

    console.log("obsidian sync: token present, length:", appSettings.user.token.length);

    try {
      await invoke("obsidian_run_sync", { settings, userToken: appSettings.user.token });
    } catch (e) {
      console.error("Failed to run sync:", e);
      toast({
        variant: "destructive",
        title: "Sync failed",
        description: String(e),
      });
    }
  };

  const handleCancel = async () => {
    try {
      await invoke("obsidian_cancel_sync");
    } catch (e) {
      console.error("Failed to cancel sync:", e);
    }
  };

  const handleEnableScheduler = async () => {
    if (!settings.vaultPath || settings.syncIntervalMinutes === 0) {
      return;
    }

    try {
      const newSettings = { ...settings, enabled: true };
      setSettings(newSettings);
      await invoke("obsidian_start_scheduler", { settings: newSettings, userToken: appSettings?.user?.token });
      toast({
        title: "Scheduler started",
        description: `Syncing every ${settings.syncIntervalMinutes} minutes`,
      });
    } catch (e) {
      console.error("Failed to start scheduler:", e);
      toast({
        variant: "destructive",
        title: "Failed to start scheduler",
        description: String(e),
      });
    }
  };

  const handleDisableScheduler = async () => {
    try {
      setSettings((s) => ({ ...s, enabled: false }));
      await invoke("obsidian_stop_scheduler");
      toast({
        title: "Scheduler stopped",
      });
    } catch (e) {
      console.error("Failed to stop scheduler:", e);
    }
  };

  const openObsidian = async () => {
    if (!settings.vaultPath) return;

    try {
      // Read Obsidian's vault registry to find the correct vault name
      const { homeDir } = await import("@tauri-apps/api/path");
      const { readTextFile } = await import("@tauri-apps/plugin-fs");
      
      const home = await homeDir();
      const { platform } = await import("@tauri-apps/plugin-os");
      const os = platform();
      const obsidianConfigPath = os === "windows"
        ? `${home}AppData\\Roaming\\obsidian\\obsidian.json`
        : `${home}Library/Application Support/obsidian/obsidian.json`;
      
      let vaultName: string | null = null;
      
      try {
        const configContent = await readTextFile(obsidianConfigPath);
        const config = JSON.parse(configContent);
        
        // Find vault that matches our path
        for (const [_id, vault] of Object.entries(config.vaults || {})) {
          const v = vault as { path: string };
          if (v.path === settings.vaultPath) {
            // Extract vault name from path
            vaultName = settings.vaultPath.split("/").pop() || null;
            break;
          }
        }
      } catch (e) {
        console.warn("Could not read Obsidian config:", e);
      }

      // Use vault name if found, otherwise just open Obsidian app
      const deepLink = vaultName 
        ? `obsidian://open?vault=${encodeURIComponent(vaultName)}`
        : "obsidian://";

      const command = os === "windows"
        ? Command.create("cmd", ["/c", "start", "", deepLink])
        : Command.create("open", [deepLink]);
      await command.execute();
      
      if (!vaultName) {
        toast({
          title: "Opened Obsidian",
          description: "Vault not found in Obsidian registry. You may need to open it manually.",
        });
      }
    } catch (e) {
      console.error("Failed to open Obsidian:", e);
      toast({
        variant: "destructive",
        title: "Failed to open Obsidian",
        description: "Make sure Obsidian is installed",
      });
    }
  };

  const formatLastSync = (isoTime: string | null) => {
    if (!isoTime) return "Never";

    const date = new Date(isoTime);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffMins = Math.floor(diffMs / 60000);

    if (diffMins < 1) return "Just now";
    if (diffMins < 60) return `${diffMins} min ago`;
    const diffHours = Math.floor(diffMins / 60);
    if (diffHours < 24) return `${diffHours} hours ago`;
    return date.toLocaleDateString();
  };

  const formatNextRun = (isoTime: string | null) => {
    if (!isoTime) return null;

    const date = new Date(isoTime);
    const now = new Date();
    const diffMs = date.getTime() - now.getTime();
    
    if (diffMs <= 0) return "any moment";
    
    const diffMins = Math.floor(diffMs / 60000);
    if (diffMins < 1) return "< 1 min";
    if (diffMins < 60) return `${diffMins} min`;
    const diffHours = Math.floor(diffMins / 60);
    const remainingMins = diffMins % 60;
    if (diffHours < 24) {
      return remainingMins > 0 ? `${diffHours}h ${remainingMins}m` : `${diffHours}h`;
    }
    return date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const isLoggedIn = Boolean(appSettings?.user?.token);
  const isSubscribed = Boolean(appSettings?.user?.cloud_subscribed);

  return (
    <Card className="border-border bg-card overflow-hidden">
      <CardContent className="p-0">
        <div className="flex items-start p-4 gap-4">
          {/* Obsidian Logo */}
          <div className="flex-shrink-0">
            <div className="w-10 h-10 rounded-xl flex items-center justify-center">
              <ObsidianLogo className="w-7 h-10" />
            </div>
          </div>

          {/* Content */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 mb-1">
              <h3 className="text-sm font-semibold text-foreground">
                Obsidian Sync
              </h3>
              {settings.enabled && (
                <span className="px-1.5 py-0.5 text-[10px] font-medium bg-foreground/10 text-foreground rounded-full">
                  ● auto
                </span>
              )}
            </div>
            <p className="text-xs text-muted-foreground mb-3">
              Sync screen activity to markdown notes. Powered by Claude AI.
            </p>

            {!isLoggedIn && (
              <Button
                variant="outline"
                size="sm"
                className="text-xs gap-1.5 h-7 mb-2"
                onClick={async () => {
                  const { openUrl } = await import("@tauri-apps/plugin-opener");
                  await openUrl("https://screenpi.pe/login");
                }}
              >
                <AlertCircle className="h-3 w-3" />
                login to use
              </Button>
            )}

            <div className="flex flex-wrap gap-2">
              <Button onClick={() => setIsExpanded(!isExpanded)} variant="outline" size="sm" className="gap-1.5 h-7 text-xs">
                {isExpanded ? "Hide" : "Configure"}
              </Button>

              {status.isSyncing ? (
                <Button onClick={handleCancel} variant="outline" size="sm" className="gap-1.5 h-7 text-xs">
                  <X className="h-3 w-3" />Cancel
                </Button>
              ) : (
                <Button onClick={handleSync} disabled={!settings.vaultPath || !isLoggedIn} size="sm" className="gap-1.5 h-7 text-xs">
                  <RefreshCw className="h-3 w-3" />Sync Now
                </Button>
              )}

              {settings.vaultPath && isValidVault && (
                <Button variant="outline" onClick={openObsidian} size="sm" className="gap-1.5 h-7 text-xs">
                  <ExternalLink className="h-3 w-3" />Open
                </Button>
              )}
            </div>
          </div>
        </div>

        {/* Expanded Settings */}
        {isExpanded && (
          <div className="px-4 pb-4 space-y-3 border-t border-border pt-3">
            {/* Vault Path */}
            <div className="space-y-1.5">
              <Label htmlFor="vault-path" className="text-xs font-medium">Notes folder</Label>
              <div className="flex gap-1.5">
                <div className="flex-1 relative">
                  <Input id="vault-path" value={settings.vaultPath} onChange={(e) => setSettings((s) => ({ ...s, vaultPath: e.target.value }))} placeholder="/path/to/folder" className={`h-7 text-xs ${isValidVault === true ? "border-green-500" : ""}`} />
                  {isValidating && <Loader2 className="absolute right-2 top-1.5 h-3 w-3 animate-spin text-muted-foreground" />}
                </div>
                <Button type="button" variant="outline" onClick={handleBrowse} size="sm" className="h-7 w-7 p-0">
                  <FolderOpen className="h-3 w-3" />
                </Button>
              </div>
              {isValidVault === true && <p className="text-[11px] text-green-500"><Check className="h-2.5 w-2.5 inline mr-0.5" />Obsidian vault detected</p>}
              {isValidVault === false && settings.vaultPath && <p className="text-[11px] text-muted-foreground"><Check className="h-2.5 w-2.5 inline mr-0.5" />Folder OK (not an Obsidian vault)</p>}
              {suggestedPaths.length > 0 && (
                <div className="flex flex-wrap gap-1 mt-1">
                  {suggestedPaths.map((path) => (
                    <Badge key={path} variant="outline" className="cursor-pointer hover:bg-muted text-[10px] h-5" onClick={() => setSettings((s) => ({ ...s, vaultPath: path }))}>
                      {path.split("/").pop()}
                    </Badge>
                  ))}
                </div>
              )}
            </div>

            {/* Notes subfolder */}
            <div className="space-y-1.5">
              <Label htmlFor="notes-path" className="text-xs font-medium">Subfolder</Label>
              <Input id="notes-path" value={settings.notesPath} onChange={(e) => setSettings((s) => ({ ...s, notesPath: e.target.value }))} placeholder="screenpipe/logs" className="h-7 text-xs" />
            </div>

            {/* Sync Hours + Interval in a row */}
            <div className="grid grid-cols-2 gap-2">
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">Hours to sync</Label>
                <Select value={String(settings.syncHours)} onValueChange={(v) => setSettings((s) => ({ ...s, syncHours: parseInt(v) }))}>
                  <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="1">Last 1h</SelectItem>
                    <SelectItem value="2">Last 2h</SelectItem>
                    <SelectItem value="4">Last 4h</SelectItem>
                    <SelectItem value="8">Last 8h</SelectItem>
                    <SelectItem value="24">Last 24h</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs font-medium">Auto-sync</Label>
                <div className="flex gap-1.5">
                  <Select value={String(settings.syncIntervalMinutes)} onValueChange={(v) => setSettings((s) => ({ ...s, syncIntervalMinutes: parseInt(v) }))}>
                    <SelectTrigger className="h-7 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="0">Manual</SelectItem>
                      <SelectItem value="15">15 min</SelectItem>
                      <SelectItem value="30">30 min</SelectItem>
                      <SelectItem value="60">1 hour</SelectItem>
                      <SelectItem value="120">2 hours</SelectItem>
                    </SelectContent>
                  </Select>
                  {settings.syncIntervalMinutes > 0 && (
                    <Button variant={settings.enabled ? "destructive" : "default"} size="sm" className="h-7 text-xs px-2" onClick={settings.enabled ? handleDisableScheduler : handleEnableScheduler} disabled={!settings.vaultPath || !isLoggedIn}>
                      {settings.enabled ? "Stop" : "Start"}
                    </Button>
                  )}
                </div>
              </div>
            </div>

            {/* Custom Prompt */}
            <div className="space-y-1.5">
              <Label htmlFor="custom-prompt" className="text-xs font-medium">Custom instructions</Label>
              <Textarea id="custom-prompt" value={settings.customPrompt} onChange={(e) => setSettings((s) => ({ ...s, customPrompt: e.target.value }))} rows={4} className="text-xs" />
            </div>
          </div>
        )}

        {/* Rate limit / upgrade banner */}
        {status.lastError && (status.lastError.includes("429") || status.lastError.includes("rate limit")) && (
          <div className="px-4 py-2 border-t border-border bg-muted/50">
            <div className="flex items-center justify-between gap-2">
              <p className="text-xs text-muted-foreground">
                <AlertCircle className="h-3 w-3 inline mr-1" />
                {isSubscribed
                  ? "usage limit reached · retrying shortly"
                  : isLoggedIn
                    ? "usage limit reached · upgrade for higher limits"
                    : "usage limit reached · sign in for 2x more"}
              </p>
              {!isSubscribed && (
                <Button
                  variant="outline"
                  size="sm"
                  className="text-xs h-6 gap-1"
                  onClick={async () => {
                    const { openUrl } = await import("@tauri-apps/plugin-opener");
                    await openUrl(isLoggedIn ? "https://screenpi.pe/pricing" : "https://screenpi.pe/login");
                  }}
                >
                  {isLoggedIn ? "upgrade" : "sign in"}
                </Button>
              )}
            </div>
          </div>
        )}

        {/* Status Bar */}
        <div className="px-4 py-2 bg-muted/50 border-t border-border">
          <div className="flex items-center gap-3 text-xs text-muted-foreground flex-wrap">
            <span>Last: <span className="text-foreground">{formatLastSync(status.lastSyncTime ?? syncHistory[0]?.timestamp ?? null)}</span></span>
            {settings.enabled && status.nextScheduledRun && (
              <span className="flex items-center gap-0.5"><Clock className="h-2.5 w-2.5" />Next: <span className="text-foreground">{formatNextRun(status.nextScheduledRun)}</span></span>
            )}
            {syncHistory.length > 0 && syncHistory.slice(0, 5).map((entry, i) => {
              const d = new Date(entry.timestamp);
              const isToday = d.toDateString() === new Date().toDateString();
              const timeStr = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
              const dateStr = d.toLocaleDateString([], { month: 'short', day: 'numeric' });
              const fullStr = d.toLocaleString();
              return (
                <span key={i} className="px-1 py-0.5 rounded bg-muted text-[10px] cursor-default" title={`${fullStr}${entry.error ? ` — ${entry.error}` : ""}`}>
                  {isToday ? timeStr : `${dateStr} ${timeStr}`}{entry.status === "success" ? " ✓" : " ✗"}
                </span>
              );
            })}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
