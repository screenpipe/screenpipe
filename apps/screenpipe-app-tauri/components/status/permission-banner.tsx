"use client";

import { useState, useEffect, useCallback } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { commands } from "@/lib/utils/tauri";
import { openPermissionSettingsWithFlow, requestPermissionWithFlow } from "@/lib/utils/permission-flow";
import { usePlatform } from "@/lib/hooks/use-platform";
import { listen } from "@tauri-apps/api/event";

interface PermissionState {
  screenOk: boolean;
  micOk: boolean;
  accessibilityOk: boolean;
}

/**
 * Persistent inline banner shown at the top of the main UI when permissions are missing.
 * Cannot be permanently dismissed — only goes away when permissions are granted.
 */
export function PermissionBanner() {
  const [permissions, setPermissions] = useState<PermissionState | null>(null);

  const { isMac } = usePlatform();

  const checkPermissions = useCallback(async () => {
    if (!isMac) return;
    try {
      const perms = await commands.doPermissionsCheck(false);
      const screenOk = perms.screenRecording === "granted" || perms.screenRecording === "notNeeded";
      const micOk = perms.microphone === "granted" || perms.microphone === "notNeeded";
      const accessibilityOk = perms.accessibility === "granted" || perms.accessibility === "notNeeded";
      setPermissions({ screenOk, micOk, accessibilityOk });

    } catch {
      // ignore errors
    }
  }, [isMac]);

  // Check on mount and poll every 5 seconds
  useEffect(() => {
    checkPermissions();
    const interval = setInterval(checkPermissions, 5000);
    return () => clearInterval(interval);
  }, [checkPermissions]);

  // Also listen for permission-lost events for instant response
  useEffect(() => {
    const unlisten = listen("permission-lost", () => {
      checkPermissions();
    });
    return () => { unlisten.then(fn => fn()); };
  }, [checkPermissions]);

  // Don't render on non-Mac or while loading
  if (!isMac || !permissions) return null;

  // Don't render if all permissions are granted
  if (permissions.screenOk && permissions.micOk && permissions.accessibilityOk) return null;



  const missingPerms: string[] = [];
  if (!permissions.screenOk) missingPerms.push("screen recording");
  if (!permissions.micOk) missingPerms.push("microphone");
  if (!permissions.accessibilityOk) missingPerms.push("accessibility");

  return (
    <div className="w-full bg-destructive border-b-2 border-destructive px-4 py-3 flex items-center justify-between gap-3 z-50">
      <div className="flex items-center gap-3 min-w-0">
        <AlertTriangle className="h-5 w-5 text-destructive-foreground shrink-0" />
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-semibold text-destructive-foreground text-base">
            {missingPerms.join(" & ")} disabled
          </span>
          <span className="text-destructive-foreground/80 hidden sm:inline text-sm">
            — recording is paused
          </span>
        </div>
      </div>
      <div className="flex items-center gap-2 shrink-0">
        <Button
          variant="secondary"
          size="sm"
          className="h-8 px-4 text-sm font-medium"
          onClick={async () => {
            // Try requestPermission first — this shows the native macOS dialog
            // (e.g. mic prompt, accessibility prompt). If the permission was already
            // denied, it falls back to opening System Settings internally.
            try {
              if (!permissions.screenOk) await requestPermissionWithFlow("screenRecording");
              else if (!permissions.micOk) await commands.requestPermission("microphone");
              else if (!permissions.accessibilityOk) await requestPermissionWithFlow("accessibility");
            } catch {
              // fallback to opening settings directly
              if (!permissions.screenOk) await openPermissionSettingsWithFlow("screenRecording");
              else if (!permissions.micOk) await commands.openPermissionSettings("microphone");
              else if (!permissions.accessibilityOk) await openPermissionSettingsWithFlow("accessibility");
            }
          }}
        >
          fix permissions
        </Button>

      </div>
    </div>
  );
}
