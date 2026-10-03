// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { useEffect, useState } from "react";
import { commands } from "@/lib/utils/tauri";
import { useSettings } from "./use-settings";
import type { StorageCapacity } from "@/lib/storage/advice";

export function useStorageCapacity(delayMs = 0, intervalMs = 0) {
  const { settings } = useSettings();
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<{
    capacity: StorageCapacity | null;
    directory: string;
    loading: boolean;
    error: boolean;
  }>({ capacity: null, directory: "", loading: true, error: false });
  useEffect(() => {
    let cancelled = false;
    let inFlight = false;
    setState({ capacity: null, directory: "", loading: true, error: false });
    const read = async () => {
      if (inFlight) return;
      inFlight = true;
      try {
        const directory = await commands.getActiveDataDir();
        if (directory.status === "error") throw new Error(directory.error);
        const result = await commands.getStorageCapacity(directory.data);
        if (result.status === "error") throw new Error(result.error);
        const capacity = result.data;
        if (
          !Number.isFinite(capacity.totalBytes) ||
          capacity.totalBytes <= 0 ||
          !Number.isFinite(capacity.availableBytes) ||
          capacity.availableBytes < 0 ||
          capacity.availableBytes > capacity.totalBytes
        )
          throw new Error("Invalid storage reading");
        if (!cancelled)
          setState({
            capacity,
            directory: directory.data,
            loading: false,
            error: false,
          });
      } catch {
        if (!cancelled)
          setState({
            capacity: null,
            directory: "",
            loading: false,
            error: true,
          });
      } finally {
        inFlight = false;
      }
    };
    const first = setTimeout(read, delayMs);
    const interval = intervalMs > 0 ? setInterval(read, intervalMs) : undefined;
    return () => {
      cancelled = true;
      clearTimeout(first);
      clearInterval(interval);
    };
  }, [settings.dataDir, revision, delayMs, intervalMs]);
  return { ...state, refresh: () => setRevision((value) => value + 1) };
}
