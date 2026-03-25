// app/providers.tsx
"use client";
import posthog from "posthog-js";
import { PostHogProvider } from "posthog-js/react";
import { useEffect } from "react";
import { ChangelogDialogProvider } from "@/lib/hooks/use-changelog-dialog";
import { SettingsProvider } from "@/lib/hooks/use-settings";
import { ThemeProvider } from "@/components/theme-provider";
import { PermissionMonitorProvider } from "@/lib/hooks/use-permission-monitor";
import { forwardRef } from "react";
import { NuqsAdapter } from "nuqs/adapters/next/app";
import { invoke } from "@tauri-apps/api/core";

export const Providers = forwardRef<
  HTMLDivElement,
  { children: React.ReactNode }
>(({ children }, ref) => {
  // Hook console to write to disk — batched to avoid IPC-per-log CPU drain
  useEffect(() => {
    const origLog = console.log;
    const origError = console.error;
    const origWarn = console.warn;
    const origDebug = console.debug;

    let buffer: { level: string; message: string }[] = [];
    let flushTimer: ReturnType<typeof setTimeout> | null = null;
    const MAX_BUFFER = 100;
    const FLUSH_INTERVAL_MS = 2000;

    function flush() {
      if (buffer.length === 0) return;
      const entries = buffer;
      buffer = [];
      invoke("write_browser_logs", { entries }).catch(() => {});
    }

    function enqueue(level: string, args: unknown[]) {
      const message = args
        .map((a) => (typeof a === "object" ? JSON.stringify(a) : String(a)))
        .join(" ");
      buffer.push({ level, message });
      if (buffer.length >= MAX_BUFFER) {
        if (flushTimer) clearTimeout(flushTimer);
        flushTimer = null;
        flush();
      } else if (!flushTimer) {
        flushTimer = setTimeout(() => {
          flushTimer = null;
          flush();
        }, FLUSH_INTERVAL_MS);
      }
    }

    console.log = (...args) => {
      origLog(...args);
      enqueue("info", args);
    };
    console.error = (...args) => {
      origError(...args);
      enqueue("error", args);
    };
    console.warn = (...args) => {
      origWarn(...args);
      enqueue("warn", args);
    };
    console.debug = (...args) => {
      origDebug(...args);
      enqueue("debug", args);
    };

    return () => {
      console.log = origLog;
      console.error = origError;
      console.warn = origWarn;
      console.debug = origDebug;
      if (flushTimer) clearTimeout(flushTimer);
      flush(); // drain remaining logs on unmount
    };
  }, []);

  useEffect(() => {
    if (typeof window !== "undefined") {
      const isDebug = process.env.TAURI_ENV_DEBUG === "true";
      if (isDebug) return;
      posthog.init("phc_z7FZXE8vmXtdTQ78LMy3j1BQWW4zP6PGDUP46rgcdnb", {
        api_host: "https://us.i.posthog.com",
        person_profiles: "identified_only",
        capture_pageview: false,
      });
      // Offline mode: opt out of PostHog immediately on init.
      // The setting is read async from the store by SettingsProvider,
      // but we also check here to prevent any early events from leaking.
      import("@/lib/hooks/use-settings").then(({ getStore }) => {
        getStore().then((store) => {
          store.get<{ offlineMode?: boolean }>("settings").then((s) => {
            if (s?.offlineMode) {
              posthog.opt_out_capturing();
            }
          });
        });
      }).catch(() => {});
    }
  }, []);

  return (
    <NuqsAdapter>
      <SettingsProvider>
        <ThemeProvider defaultTheme="light" storageKey="screenpipe-ui-theme">
          <ChangelogDialogProvider>
            <PermissionMonitorProvider>
              <PostHogProvider client={posthog}>{children}</PostHogProvider>
            </PermissionMonitorProvider>
          </ChangelogDialogProvider>
        </ThemeProvider>
      </SettingsProvider>
    </NuqsAdapter>
  );
});

Providers.displayName = "Providers";
