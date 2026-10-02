// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";

import { useEffect, useRef, useState } from "react";
import { getMediaFile } from "@/lib/actions/video-actions";
import type { MeetingAudioChunk } from "@/lib/utils/meeting-context";

export interface ReplayAudioFile {
  path: string;
  startMs: number;
  input: boolean;
}

// Many transcript turns point into the same recording. Load it only once and
// subtract the segment offset to align the file's clock with the replay clock.
export function replayAudioFiles(
  chunks: MeetingAudioChunk[],
): ReplayAudioFile[] {
  const files = new Map<string, ReplayAudioFile>();
  const aligned = new Set<string>();
  for (const chunk of chunks) {
    const offset = chunk.audioStartTimeSecs ?? 0;
    const startMs = Date.parse(chunk.timestamp) - offset * 1000;
    if (
      !chunk.audioFilePath ||
      !Number.isFinite(startMs) ||
      !Number.isFinite(offset) ||
      offset < 0
    )
      continue;
    const previous = files.get(chunk.audioFilePath);
    const hasOffset = chunk.audioStartTimeSecs != null;
    // Older live rows may have no offset. Prefer a later turn with a real
    // file offset over treating that earlier turn as the file's start.
    if (
      !previous ||
      (hasOffset && !aligned.has(chunk.audioFilePath)) ||
      (hasOffset === aligned.has(chunk.audioFilePath) &&
        startMs < previous.startMs)
    ) {
      if (hasOffset) aligned.add(chunk.audioFilePath);
      files.set(chunk.audioFilePath, {
        path: chunk.audioFilePath,
        startMs,
        input: chunk.isInput,
      });
    }
  }
  return [...files.values()].sort((a, b) => a.startMs - b.startMs);
}

// At most one recording per direction, so duplicated mic/output device rows
// cannot amplify or echo the same recording. File duration bounds gaps below.
export function replayAudioAt(
  files: ReplayAudioFile[],
  cursorMs: number,
): ReplayAudioFile[] {
  const lanes = new Map<boolean, ReplayAudioFile>();
  for (const file of files) {
    if (file.startMs <= cursorMs) lanes.set(file.input, file);
  }
  return [...lanes.values()];
}

export function ReplayAudio({
  file,
  cursorMs,
  playing,
  muted,
  rate,
  onStatus,
}: {
  file: ReplayAudioFile;
  cursorMs: number;
  playing: boolean;
  muted: boolean;
  rate: number;
  onStatus: (path: string, status: "loading" | "ready" | "error") => void;
}) {
  const ref = useRef<HTMLAudioElement>(null);
  const [src, setSrc] = useState<string>();
  const [ready, setReady] = useState(false);
  const playPending = useRef(false);
  const mounted = useRef(true);

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | undefined;
    onStatus(file.path, "loading");
    void getMediaFile(file.path)
      .then(({ data, mimeType }) => {
        if (cancelled) return;
        const bytes = Uint8Array.from(atob(data), (char) => char.charCodeAt(0));
        objectUrl = URL.createObjectURL(
          new Blob([bytes], {
            type: mimeType === "video/mp4" ? "audio/mp4" : mimeType,
          }),
        );
        setSrc(objectUrl);
      })
      .catch(() => {
        if (!cancelled) onStatus(file.path, "error");
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [file.path, onStatus]);

  useEffect(() => {
    const audio = ref.current;
    if (!audio || !ready) return;
    const position = Math.max(0, (cursorMs - file.startMs) / 1000);
    audio.muted = muted;
    audio.playbackRate = rate;
    if (Number.isFinite(audio.duration) && position >= audio.duration) {
      audio.pause();
      return;
    }
    if (Math.abs(audio.currentTime - position) > 0.35)
      audio.currentTime = position;
    if (!playing || muted) {
      audio.pause();
    } else if (audio.paused && !playPending.current) {
      playPending.current = true;
      void audio
        .play()
        .catch((error: unknown) => {
          // Pausing or seeking while a play promise is pending is expected.
          if (
            mounted.current &&
            !(error instanceof DOMException && error.name === "AbortError")
          ) {
            onStatus(file.path, "error");
          }
        })
        .finally(() => {
          playPending.current = false;
        });
    }
  }, [
    cursorMs,
    file.startMs,
    file.path,
    playing,
    muted,
    rate,
    ready,
    onStatus,
  ]);

  useEffect(() => {
    const audio = ref.current;
    mounted.current = true;
    return () => {
      mounted.current = false;
      audio?.pause();
    };
  }, []);

  return (
    <audio
      ref={ref}
      src={src}
      preload="auto"
      data-testid="replay-audio"
      onCanPlay={() => {
        setReady(true);
        onStatus(file.path, "ready");
      }}
      onWaiting={() => onStatus(file.path, "loading")}
      onError={() => onStatus(file.path, "error")}
    />
  );
}
