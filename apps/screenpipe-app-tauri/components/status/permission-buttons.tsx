import React, { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Check, Lock, Settings, X } from "lucide-react";
import { toast } from "@/components/ui/use-toast";
import { commands, OSPermissionsCheck, OSPermissionStatus } from "@/lib/utils/tauri";
import { openPermissionSettingsWithFlow, requestPermissionWithFlow } from "@/lib/utils/permission-flow";
import { usePlatform } from "@/lib/hooks/use-platform";
import { useSettings } from "@/lib/hooks/use-settings";
import localforage from "localforage";

interface PermissionButtonsProps {
  type: "screen" | "audio";
  hideWindowOnClick?: boolean;
}

export const PermissionButtons: React.FC<PermissionButtonsProps> = ({
  type,
  hideWindowOnClick = false,
}) => {
  const { settings } = useSettings();
  const [permissions, setPermissions] = useState<OSPermissionsCheck | null>(
    null
  );
  const { isMac: isMacOS } = usePlatform();

  // Initial permission check (once)
  useEffect(() => {
    const checkPermissions = async () => {
      if (isMacOS) {
        try {
          const perms = await commands.doPermissionsCheck(true);
          setPermissions(perms);
        } catch (error) {
          console.error("Failed to check permissions:", error);
        }
      }
    };

    checkPermissions();
  }, [isMacOS]);

  // Poll microphone permission only (screen requires app restart)
  useEffect(() => {
    if (!isMacOS || type !== "audio") return;

    const checkMicPermission = async () => {
      try {
        const micStatus = await commands.checkMicrophonePermission();
        setPermissions(prev => prev ? { ...prev, microphone: micStatus } : null);
      } catch (error) {
        console.error("Failed to check mic permission:", error);
      }
    };

    const intervalId = setInterval(checkMicPermission, 1000);
    return () => clearInterval(intervalId);
  }, [isMacOS, type]);

  const handlePermissionButton = async () => {
    try {
      const permissionType =
        type === "screen"
          ? "screenRecording"
          : "microphone";

      // Hide the main window so user can see the system settings
      if (hideWindowOnClick) {
        await commands.closeWindow("Main");
      }

      if (permissionType === "screenRecording") {
        await requestPermissionWithFlow(permissionType);
      } else {
        await commands.requestPermission(permissionType);
      }

      // Refresh permissions after request
      const perms = await commands.doPermissionsCheck(false);
      setPermissions(perms);

      // If screen recording permission was requested, set flag and prompt for restart
      if (type === "screen") {
        await localforage.setItem("screenPermissionRestartPending", true);

        toast({
          title: "restart required",
          description:
            "please restart the app to apply screen recording permission",
          duration: 5000,
        });
      }
    } catch (error) {
      console.error(`Failed to request ${type} permission:`, error);
      toast({
        title: "error",
        description: `failed to request ${type} permission`,
        variant: "destructive",
        duration: 3000,
      });
    }
  };

  const handleOpenPermissionSettings = async () => {
    try {
      const permissionType =
        type === "screen"
          ? "screenRecording"
          : "microphone";

      // Hide the main window so user can see the system settings
      if (hideWindowOnClick) {
        await commands.closeWindow("Main");
      }

      if (permissionType === "screenRecording") {
        await openPermissionSettingsWithFlow(permissionType);
      } else {
        await commands.openPermissionSettings(permissionType);
      }
    } catch (error) {
      console.error(`failed to open ${type} permission settings:`, error);
      toast({
        title: "error",
        description: `failed to open ${type} permission settings`,
        variant: "destructive",
        duration: 3000,
      });
    }
  };

  if (!isMacOS) return null;

  const isPermitted = (status: OSPermissionStatus) =>
    status === "granted" || status === "notNeeded";

  const permissionStatus =
    type === "screen"
      ? permissions?.screenRecording
      : permissions?.microphone;

  const isDisabled = type === "audio" && settings.disableAudio;

  return (
    <div className="flex items-center gap-2">
      {permissions && (
        <span>
          {isPermitted(permissionStatus ?? "empty") ? (
            <Check className="h-4 w-4 text-green-500" />
          ) : (
            <X className="h-4 w-4 text-red-500" />
          )}
        </span>
      )}
      <Button
        variant="outline"
        className="text-sm justify-center w-[220px]"
        onClick={handlePermissionButton}
        disabled={isDisabled}
      >
        allow{" "}
        {type === "screen"
          ? "screen"
          : "audio"}{" "}
        access
      </Button>
      <Button
        variant="ghost"
        size="icon"
        className="h-8 w-8"
        onClick={handleOpenPermissionSettings}
        title={`Open ${type} settings`}
        disabled={isDisabled}
      >
        <Settings className="h-4 w-4" />
      </Button>
    </div>
  );
};
