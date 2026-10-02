// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { memo, useCallback, useEffect, useState, useRef, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { getMediaFile } from '@/lib/actions/video-actions'
import { isAudioMediaPath, normalizeMediaFilePath } from "@/lib/utils/media-file-path";
import { useGT } from "gt-react";


const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY = 500; // ms
const MAX_MEDIA_CACHE_ENTRIES = 12;
const MAX_FAILED_MEDIA_ENTRIES = 100;

type CachedMedia = {
  src: string;
  mimeType: string;
  isAudio: boolean;
};

const mediaCache = new Map<string, CachedMedia>();
const activeMediaSrcRefs = new Map<string, number>();

// Paths that still failed after every retry, with the error shown for them.
// A player with text to show instead (the chat) mounting one again shows that
// text at once and checks the file a single time instead of retrying for
// seconds. A player with nothing else to show (meeting audio) keeps loading
// and retrying as usual.
const failedMedia = new Map<string, string>();

function rememberFailedMedia(filePath: string, error: string) {
  failedMedia.delete(filePath);
  failedMedia.set(filePath, error);
  if (failedMedia.size > MAX_FAILED_MEDIA_ENTRIES) {
    const oldest = failedMedia.keys().next().value;
    if (oldest !== undefined) failedMedia.delete(oldest);
  }
}

function getCachedMedia(filePath: string): CachedMedia | null {
  const cached = mediaCache.get(filePath);
  if (!cached) return null;
  mediaCache.delete(filePath);
  mediaCache.set(filePath, cached);
  return cached;
}

function setCachedMedia(filePath: string, media: CachedMedia) {
  mediaCache.set(filePath, media);
  while (mediaCache.size > MAX_MEDIA_CACHE_ENTRIES) {
    const oldest = mediaCache.keys().next().value;
    if (!oldest) break;
    const evicted = mediaCache.get(oldest);
    mediaCache.delete(oldest);
    if (evicted && !activeMediaSrcRefs.has(evicted.src)) {
      URL.revokeObjectURL(evicted.src);
    }
  }
}

function isCachedMediaSrc(src: string) {
  for (const cached of mediaCache.values()) {
    if (cached.src === src) return true;
  }
  return false;
}

function retainMediaSrc(src: string) {
  activeMediaSrcRefs.set(src, (activeMediaSrcRefs.get(src) ?? 0) + 1);
}

function releaseMediaSrc(src: string) {
  const count = activeMediaSrcRefs.get(src) ?? 0;
  if (count > 1) {
    activeMediaSrcRefs.set(src, count - 1);
    return;
  }

  activeMediaSrcRefs.delete(src);
  if (!isCachedMediaSrc(src)) {
    URL.revokeObjectURL(src);
  }
}

export const MediaComponent = memo(function MediaComponent({
  filePath,
  customDescription,
  className,
  startTimeSecs,
  fallback,
}: {
  filePath: string;
  customDescription?: string;
  className?: string;
  startTimeSecs?: number;
  /** Shown instead of the error box when the file can't be read. */
  fallback?: ReactNode;
}) {

  const ui = useGT();
  const initialPath = normalizeMediaFilePath(filePath);
  const hasFallback = fallback !== undefined;
  const [error, setError] = useState<string | null>(() =>
    hasFallback ? failedMedia.get(initialPath) ?? null : null,
  );
  const initialCachedMedia = getCachedMedia(initialPath);
  const [isAudio, setIsAudio] = useState(() => initialCachedMedia?.isAudio ?? isAudioMediaPath(initialPath));
  const [mimeType, setMimeType] = useState<string | null>(() => initialCachedMedia?.mimeType ?? null);
  const [mediaSrc, setMediaSrc] = useState<string | null>(() => initialCachedMedia?.src ?? null);
  const [retryCount, setRetryCount] = useState(0);
  const mediaElementRef = useRef<HTMLAudioElement | HTMLVideoElement | null>(null);

  const sanitizeFilePath = useCallback((path: string): string => {
    return normalizeMediaFilePath(path);
  }, []);

  const displayPath = initialPath;

  const renderFileLink = () => (
    <div className="mt-2 text-center text-xs text-muted-foreground truncate px-2" title={displayPath}>
      {customDescription || displayPath}
    </div>
  );

  useEffect(() => {
    let isCancelled = false;
    let retryTimeout: NodeJS.Timeout | null = null;
    const initialSanitizedPath = sanitizeFilePath(filePath);
    // A file that already failed shows the fallback straight away and is
    // checked once more, in case it has appeared since.
    const knownFailure = hasFallback ? failedMedia.get(initialSanitizedPath) ?? null : null;
    const maxRetries = knownFailure ? 0 : MAX_RETRIES;

    async function loadMedia(attempt: number = 0) {
      try {
        const sanitizedPath = sanitizeFilePath(filePath);
        if (!sanitizedPath) {
          throw new Error("Invalid file path");
        }

        const isAudioFile = isAudioMediaPath(sanitizedPath);

        if (!isCancelled) {
          setIsAudio(isAudioFile);
        }

        const { data, mimeType } = await getMediaFile(sanitizedPath);
        const mediaMimeType = isAudioFile && mimeType === "video/mp4" ? "audio/mp4" : mimeType;

        if (isCancelled) return;

        const binaryData = atob(data);
        const bytes = new Uint8Array(binaryData.length);
        for (let i = 0; i < binaryData.length; i++) {
          bytes[i] = binaryData.charCodeAt(i);
        }
        const blob = new Blob([bytes], { type: mediaMimeType });
        const blobUrl = URL.createObjectURL(blob);

        setCachedMedia(sanitizedPath, {
          src: blobUrl,
          mimeType: mediaMimeType,
          isAudio: isAudioFile,
        });
        failedMedia.delete(sanitizedPath);
        setMediaSrc(blobUrl);
        setMimeType(mediaMimeType);
        setError(null);
        setRetryCount(0);
      } catch (error) {
        if (isCancelled) return;

        const errorMessage = error instanceof Error ? error.message : "Unknown error";
        console.warn(`Failed to load media (attempt ${attempt + 1}):`, errorMessage);

        // Retry with exponential backoff for transient errors
        if (attempt < maxRetries) {
          const delay = INITIAL_RETRY_DELAY * Math.pow(2, attempt);
          setRetryCount(attempt + 1);
          retryTimeout = setTimeout(() => {
            if (!isCancelled) {
              loadMedia(attempt + 1);
            }
          }, delay);
        } else {
          const message = ui("Failed to load media: {value1}", { value1: errorMessage });
          rememberFailedMedia(initialSanitizedPath, message);
          setError(message);
          setRetryCount(0);
        }
      }
    }

    // Reset state when filePath changes
    const cachedMedia = getCachedMedia(initialSanitizedPath);
    setError(knownFailure);
    setRetryCount(0);

    if (cachedMedia) {
      setMediaSrc(cachedMedia.src);
      setMimeType(cachedMedia.mimeType);
      setIsAudio(cachedMedia.isAudio);
      return () => {
        isCancelled = true;
        if (retryTimeout) {
          clearTimeout(retryTimeout);
        }
      };
    }

    setMediaSrc(null);
    setMimeType(null);
    setIsAudio(isAudioMediaPath(initialSanitizedPath));

    loadMedia();

    return () => {
      isCancelled = true;
      if (retryTimeout) {
        clearTimeout(retryTimeout);
      }
    };
  }, [filePath, sanitizeFilePath, hasFallback]);

  useEffect(() => {
    if (!mediaSrc) return;
    retainMediaSrc(mediaSrc);
    return () => releaseMediaSrc(mediaSrc);
  }, [mediaSrc]);

  // Seek to startTimeSecs when media is ready
  useEffect(() => {
    const el = mediaElementRef.current;
    if (!el || !mediaSrc || startTimeSecs == null || startTimeSecs <= 0) return;
    const handleLoaded = () => {
      if (startTimeSecs < el.duration) {
        el.currentTime = startTimeSecs;
      }
    };
    // If already loaded, seek immediately
    if (el.readyState >= 1) {
      handleLoaded();
    } else {
      el.addEventListener("loadedmetadata", handleLoaded, { once: true });
      return () => el.removeEventListener("loadedmetadata", handleLoaded);
    }
  }, [mediaSrc, startTimeSecs]);

  if (error) {
    if (fallback !== undefined) return <>{fallback}</>;
    return (
      <div className="w-full p-4 bg-red-100 border border-red-300 rounded-md">
        <p className="text-red-700">{error}</p>
        {renderFileLink()}
      </div>
    );
  }

  if (!mediaSrc) {
    return (
      <div
        className={cn(
          isAudio
            ? "w-full h-[84px] bg-muted animate-pulse rounded-md flex items-center justify-center"
            : "w-full h-48 bg-muted animate-pulse rounded-md flex items-center justify-center",
          className
        )}
      >
        <span className="text-muted-foreground">Loading media...</span>
      </div>
    );
  }

  return (
    <div className={cn("w-full max-w-2xl text-center isolate", className)}>
      {isAudio ? (
        <div className="relative z-10 bg-muted p-4 rounded-md min-h-[84px] flex items-center">
          <audio ref={(el) => { mediaElementRef.current = el; }} controls className="w-full pointer-events-auto">
            <source src={mediaSrc} type={mimeType || "audio/mpeg"} />
            Your browser does not support the audio element.
          </audio>
        </div>
      ) : (
        <div className="relative z-10">
          <video ref={(el) => { mediaElementRef.current = el; }} controls className="w-full rounded-md pointer-events-auto">
            <source src={mediaSrc} type='video/mp4; codecs="hvc1"' />
            <source src={mediaSrc} type='video/mp4; codecs="hvec"' />
            <source src={mediaSrc} type="video/mp4" />
            Your browser does not support the video tag.
          </video>
        </div>
      )}
      {renderFileLink()}
    </div>
  );
});
