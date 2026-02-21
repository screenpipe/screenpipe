import React, { useEffect, useState } from "react";
import { Settings, Shortcut, useSettings } from "@/lib/hooks/use-settings";
import { parseKeyboardShortcut } from "@/lib/utils";
import { Switch } from "@/components/ui/switch";
import { toast } from "@/components/ui/use-toast";
import { cn } from "@/lib/utils";
import { Pencil } from "lucide-react";
import { commands } from "@/lib/utils/tauri";
import { invoke } from "@tauri-apps/api/core";
import hotkeys from "hotkeys-js";

interface ShortcutRowProps {
  shortcut: string;
  title: string;
  description: string;
  type: "global";
  value?: string;
}

enum ShortcutState {
  ENABLED = "enabled",
  DISABLED = "disabled",
  UNASSIGNED = "unassigned",
}

const ShortcutRow = ({
  shortcut,
  title,
  description,
  type,
  value,
}: ShortcutRowProps) => {
  const [isRecording, setIsRecording] = useState(false);
  const { settings, updateSettings } = useSettings();

  useEffect(() => {
    if (!isRecording) return;

    // Suspend all global shortcuts so they don't fire while recording
    // (e.g., pressing Ctrl+Cmd+K to assign it shouldn't open the overlay)
    invoke("suspend_global_shortcuts").catch(() => {});

    const handleKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();

      const MODIFIER_KEYS = ["SUPER", "CTRL", "ALT", "SHIFT"] as const;
      const KEY_CODE_MAP: Record<number, string> = {
        91: "SUPER",
        93: "SUPER",
        16: "SHIFT",
        17: "CTRL",
        18: "ALT",
      };

      const pressedKeys = hotkeys
        .getPressedKeyCodes()
        .map((code) => KEY_CODE_MAP[code] || String.fromCharCode(code))
        .filter((value, index, self) => self.indexOf(value) === index);

      const modifiers = pressedKeys.filter((k) =>
        MODIFIER_KEYS.includes(k as any)
      );
      const normalKeys = pressedKeys.filter(
        (k) => !MODIFIER_KEYS.includes(k as any)
      );
      const finalKeys = [...modifiers, ...normalKeys];

      if (normalKeys.length > 0) {
        handleEnableShortcut(finalKeys.join("+"));
        setIsRecording(false);
      }
    };

    hotkeys.filter = () => true;
    hotkeys("*", handleKeyDown);

    return () => {
      setIsRecording(false);
      // Re-register all global shortcuts after recording
      invoke("resume_global_shortcuts").catch(() => {});
      hotkeys.unbind("*");
      hotkeys.filter = (event) => {
        const target = (event.target || event.srcElement) as any;
        return !(
          target.isContentEditable ||
          target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA"
        );
      };
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRecording]);

  const syncShortcuts = async (updatedShortcuts: {
    showScreenpipeShortcut: string;
    startRecordingShortcut: string;
    stopRecordingShortcut: string;
    startAudioShortcut: string;
    stopAudioShortcut: string;
    showChatShortcut: string;
  }) => {
    console.log("syncing shortcuts:", {
      showShortcut: updatedShortcuts.showScreenpipeShortcut,
      startShortcut: updatedShortcuts.startRecordingShortcut,
      stopShortcut: updatedShortcuts.stopRecordingShortcut,
      startAudioShortcut: updatedShortcuts.startAudioShortcut,
      stopAudioShortcut: updatedShortcuts.stopAudioShortcut,
      showChatShortcut: updatedShortcuts.showChatShortcut,
    });
    // wait 1 second for settings to persist
    await new Promise((resolve) => setTimeout(resolve, 1000));
    // updateGlobalShortcuts re-reads all shortcuts from store including showChatShortcut
    await commands.updateGlobalShortcuts(
      updatedShortcuts.showScreenpipeShortcut,
      updatedShortcuts.startRecordingShortcut,
      updatedShortcuts.stopRecordingShortcut,
      updatedShortcuts.startAudioShortcut,
      updatedShortcuts.stopAudioShortcut,
    {}
    );

    return true;
  };

  const handleEnableShortcut = async (keys: string) => {
    try {
      // Check for conflicts with other shortcuts
      const normalizedKeys = keys.toLowerCase();
      const allShortcuts: Record<string, string> = {
        showScreenpipeShortcut: settings.showScreenpipeShortcut,
        startRecordingShortcut: settings.startRecordingShortcut,
        stopRecordingShortcut: settings.stopRecordingShortcut,
        startAudioShortcut: settings.startAudioShortcut,
        stopAudioShortcut: settings.stopAudioShortcut,
        showChatShortcut: settings.showChatShortcut,
        searchShortcut: settings.searchShortcut,
      };
      const conflict = Object.entries(allShortcuts).find(
        ([key, value]) =>
          key !== shortcut &&
          value &&
          value.toLowerCase() === normalizedKeys &&
          !settings.disabledShortcuts.includes(key as Shortcut)
      );
      if (conflict) {
        toast({
          title: "shortcut conflict",
          description: `this shortcut is already used by "${conflict[0].replace(/([A-Z])/g, " $1").trim().toLowerCase()}". choose a different combination.`,
          variant: "destructive",
        });
        return;
      }

      toast({
        title: "shortcut enabled",
        description: `${shortcut.replace(/_/g, " ")} enabled`,
      });

      // Remove from disabled shortcuts if it exists
      updateSettings({
        disabledShortcuts: settings.disabledShortcuts.filter(
          (s) => s !== shortcut
        ),
      });

      switch (type) {
        case "global":
          updateSettings({ [shortcut]: keys });
          // Build updated shortcuts with the NEW value for the changed shortcut
          const updatedShortcuts = {
            showScreenpipeShortcut: shortcut === "showScreenpipeShortcut" ? keys : settings.showScreenpipeShortcut,
            startRecordingShortcut: shortcut === "startRecordingShortcut" ? keys : settings.startRecordingShortcut,
            stopRecordingShortcut: shortcut === "stopRecordingShortcut" ? keys : settings.stopRecordingShortcut,
            startAudioShortcut: shortcut === "startAudioShortcut" ? keys : settings.startAudioShortcut,
            stopAudioShortcut: shortcut === "stopAudioShortcut" ? keys : settings.stopAudioShortcut,
            showChatShortcut: shortcut === "showChatShortcut" ? keys : settings.showChatShortcut,
          };
          await syncShortcuts(updatedShortcuts);

          // Update the shortcut reminder overlay if either show shortcut changed
          if (shortcut === "showScreenpipeShortcut" || shortcut === "showChatShortcut") {
            try {
              await invoke("show_shortcut_reminder", { shortcut: updatedShortcuts.showScreenpipeShortcut });
            } catch (e) {
              // Window may not exist, that's ok
            }
          }
          break;
        default:
          throw new Error(`Invalid shortcut type: ${type}`);
      }
    } catch (error) {
      console.error("error updating shortcut", error);
      toast({
        title: "error updating shortcut",
        description:
          "failed to register shortcut. please try a different combination.",
        variant: "destructive",
      });
    }
  };

  const handleDisableShortcut = async () => {
    toast({
      title: "shortcut disabled",
      description: `${shortcut.replace(/_/g, " ")} disabled`,
    });
    updateSettings({
      disabledShortcuts: Array.from(
        new Set([...settings.disabledShortcuts, shortcut as Shortcut])
      ),
    });

    await syncShortcuts({
      showScreenpipeShortcut: settings.showScreenpipeShortcut,
      startRecordingShortcut: settings.startRecordingShortcut,
      stopRecordingShortcut: settings.stopRecordingShortcut,
      startAudioShortcut: settings.startAudioShortcut,
      stopAudioShortcut: settings.stopAudioShortcut,
      showChatShortcut: settings.showChatShortcut,
    });
  };

  const isValueEmpty = (v: string | undefined): boolean =>
    !v || v.trim() === "";

  const currentKeys = isValueEmpty(value)
    ? ["Unassigned"]
    : parseKeyboardShortcut(value || "").split("+");

  const getShortcutState = (): ShortcutState => {
    if (isValueEmpty(value)) return ShortcutState.UNASSIGNED;
    return settings.disabledShortcuts.includes(shortcut as Shortcut)
      ? ShortcutState.DISABLED
      : ShortcutState.ENABLED;
  };

  return (
    <div className="flex items-center justify-between">
      <div className="space-y-1">
        <h4 className="font-medium">{title}</h4>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
      <div className="flex items-center gap-4">
        <button
          onClick={() => setIsRecording(true)}
          className={cn(
            "relative min-w-[140px] rounded-md border px-3 py-2 text-sm",
            "bg-muted/50 hover:bg-muted/70 transition-colors",
            "focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-ring",
            isRecording && "border-primary",
            !value && "text-muted-foreground"
          )}
        >
          {isRecording ? (
            <span className="animate-pulse">recording...</span>
          ) : (
            <span className="flex items-center justify-between gap-2">
              {currentKeys.map((key, i) => (
                <kbd
                  key={i}
                  className={cn(
                    "px-1 rounded",
                    value ? "bg-background/50" : "bg-transparent"
                  )}
                >
                  {key}
                </kbd>
              ))}
              <Pencil className="h-3 w-3 opacity-50" />
            </span>
          )}
        </button>

        <Switch
          checked={getShortcutState() === ShortcutState.ENABLED}
          disabled={getShortcutState() === ShortcutState.UNASSIGNED}
          onCheckedChange={async (checked) => {
            if (checked && value) {
              console.log("re-enabling shortcut", value);
              await handleEnableShortcut(value);
            } else {
              console.log("disabling shortcut", shortcut);
              await handleDisableShortcut();
            }
          }}
        />
      </div>
    </div>
  );
};

export default ShortcutRow;
