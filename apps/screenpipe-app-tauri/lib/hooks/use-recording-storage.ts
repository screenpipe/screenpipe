// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { useEffect, useState } from "react";
import { useSettings } from "./use-settings";
import { commands } from "@/lib/utils/tauri";

export interface RecordingStorageWarning {
  availableBytes: number;
  thresholdBytes: number;
}

/** Inspect storage only while capture is paused. Never poll or scan the data
 * directory on the active recording path. Native capture owns the safety guard. */
export function useRecordingStorage(paused: boolean) {
  const { settings } = useSettings();
  const enabled = paused && (settings.stopRecordingOnLowDisk ?? true);
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{
    directory?: string;
    warning: RecordingStorageWarning | null;
    checking: boolean;
    error: boolean;
  }>({ warning: null, checking: false, error: false });

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    setState((previous) => ({
      directory: settings.dataDir,
      warning: previous.directory === settings.dataDir ? previous.warning : null,
      checking: true,
      error: false,
    }));
    void (async () => {
      try {
        const activeDirectory = await commands.getActiveDataDir();
        if (activeDirectory.status === "error") {
          throw new Error(String(activeDirectory.error));
        }
        const directory = activeDirectory.data;
        const [usage, config] = await Promise.all([
          commands.getDiskUsage(true, directory),
          commands.getLowDiskGuardConfig(),
        ]);
        if (usage.status === "error") throw new Error(String(usage.error));
        const data = usage.data;
        if (!data || typeof data !== "object" || Array.isArray(data)) {
          throw new Error("storage status unavailable");
        }
        const availableBytes = data.available_space_bytes;
        const thresholdBytes = config.thresholdBytes;
        if (
          typeof availableBytes !== "number" ||
          !Number.isFinite(availableBytes) || availableBytes < 0 ||
          !Number.isFinite(thresholdBytes) || thresholdBytes <= 0
        ) {
          throw new Error("storage status unavailable");
        }
        if (!cancelled) {
          setState({
            directory: settings.dataDir,
            checking: false,
            error: false,
            warning: availableBytes <= thresholdBytes
              ? { availableBytes, thresholdBytes } : null,
          });
        }
      } catch {
        if (!cancelled) {
          setState({ directory: settings.dataDir, warning: null, checking: false, error: true });
        }
      }
    })();
    return () => { cancelled = true; };
  }, [enabled, settings.dataDir, revision]);

  return {
    warning: enabled && state.directory === settings.dataDir ? state.warning : null,
    checking: enabled && state.checking,
    error: enabled && state.error,
    refresh: () => setRevision(value => value + 1),
  };
}
