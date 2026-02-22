import { useState, useEffect, useCallback } from "react";
import { commands, PiInfo, PiCheckResult } from "@/lib/utils/tauri";
import { listen } from "@tauri-apps/api/event";

export interface PipeRun {
  id: string;
  pipeName: string;
  startedAt: Date;
  endedAt?: Date;
  status: "running" | "completed" | "failed";
  output?: string;
}

export interface UsePiResult {
  info: PiInfo | null;
  checkResult: PiCheckResult | null;
  isLoading: boolean;
  error: string | null;
  logs: string[];
  pipeRuns: PipeRun[];
  start: (projectDir: string, userToken?: string) => Promise<PiInfo | null>;
  stop: () => Promise<void>;
  refresh: () => Promise<void>;
  check: () => Promise<void>;
  clearError: () => void;
  clearPipeRuns: () => void;
}

export function usePi(): UsePiResult {
  const [info, setInfo] = useState<PiInfo | null>(null);
  const [checkResult, setCheckResult] = useState<PiCheckResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [logs, setLogs] = useState<string[]>([]);

  const refresh = useCallback(async () => {
    try {
      const result = await commands.piInfo();
      if (result.status === "ok") {
        setInfo(result.data);
      } else {
        setError(result.error);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const check = useCallback(async () => {
    try {
      const result = await commands.piCheck();
      if (result.status === "ok") {
        setCheckResult(result.data);
      } else {
        setError(result.error);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const start = useCallback(async (projectDir: string, userToken?: string): Promise<PiInfo | null> => {
    setIsLoading(true);
    setError(null);
    setLogs([]);
    try {
      const result = await commands.piStart(projectDir, userToken ?? null, null);
      if (result.status === "ok") {
        setInfo(result.data);
        return result.data;
      } else {
        setError(result.error);
        return null;
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      return null;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const stop = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await commands.piStop();
      if (result.status === "ok") {
        setInfo(result.data);
      } else {
        setError(result.error);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsLoading(false);
    }
  }, []);

  const clearError = useCallback(() => {
    setError(null);
  }, []);

  // Initial check on mount
  useEffect(() => {
    check();
    refresh();
  }, [check, refresh]);

  // Listen for Pi events
  useEffect(() => {
    const unlistenLog = listen<string>("pi_log", (event) => {
      setLogs((prev) => [...prev.slice(-99), event.payload]);
    });

    const unlistenOutput = listen<string>("pi_output", (event) => {
      setLogs((prev) => [...prev.slice(-99), event.payload]);
    });

    const unlistenTerminated = listen<number | null>("pi_terminated", () => {
      refresh();
    });

    const unlistenError = listen<string>("pi_error", (event) => {
      setError(event.payload);
      refresh();
    });

    return () => {
      unlistenLog.then((fn) => fn());
      unlistenOutput.then((fn) => fn());
      unlistenTerminated.then((fn) => fn());
      unlistenError.then((fn) => fn());
    };
  }, [refresh]);

  // Poll for status while running
  useEffect(() => {
    if (info?.running) {
      const interval = setInterval(refresh, 10000);
      return () => clearInterval(interval);
    }
  }, [info?.running, refresh]);

  return {
    info,
    checkResult,
    isLoading,
    error,
    logs,
    start,
    stop,
    refresh,
    check,
    clearError,
  };
}
