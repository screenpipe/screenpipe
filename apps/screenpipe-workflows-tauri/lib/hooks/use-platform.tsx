import { getVersion } from "@tauri-apps/api/app";
import { OsType, type } from "@tauri-apps/plugin-os";
import { create } from "zustand";

type PlatformState = {
  platform: OsType | "unknown";
  version: string;
  isMac: boolean;
  isWindows: boolean;
  isLinux: boolean;
  isLoading: boolean;
  error: string | null;
  init: () => Promise<void>;
};

const usePlatformStore = create<PlatformState>((set) => ({
  platform: "unknown",
  version: "",
  isMac: false,
  isWindows: false,
  isLinux: false,
  isLoading: true,
  error: null,
  init: async () => {
    try {
      // check if we're in a tauri environment
      if (typeof type !== "function") {
        set({
          isLoading: false,
          error: "not in tauri environment",
          platform: "unknown",
        });
        return;
      }

      const platform = type();
      const version = await getVersion();

      set({
        platform,
        version,
        isMac: platform === "macos",
        isWindows: platform === "windows",
        isLinux: platform === "linux",
        isLoading: false,
      });
    } catch (error) {
      set({
        isLoading: false,
        error: error instanceof Error ? error.message : "unknown error",
      });
    }
  },
}));

// initialize the store on first import
let initialized = false;

export function usePlatform() {
  const store = usePlatformStore();

  // initialize only once
  if (!initialized) {
    initialized = true;
    store.init();
  }

  return store;
}
