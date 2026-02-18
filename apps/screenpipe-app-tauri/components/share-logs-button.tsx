import { Button } from "./ui/button";
import { useToast } from "./ui/use-toast";
import { Upload, Loader, Copy, X, Camera, Video } from "lucide-react";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { commands, LogFile } from "@/lib/utils/tauri";
import { useState, useEffect } from "react";
import { useCopyToClipboard } from "@/lib/hooks/use-copy-to-clipboard";
import { useSettings } from "@/lib/hooks/use-settings";
import { getVersion } from "@tauri-apps/api/app";
import {
  version as osVersion,
  platform as osPlatform,
} from "@tauri-apps/plugin-os";
import { Textarea } from "./ui/textarea";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
  TooltipProvider,
} from "./ui/tooltip";
import { useHealthCheck } from "@/lib/hooks/use-health-check";

interface VideoChunk {
  device_name: string;
  file_path: string;
  id: number;
}

const ShareLinkDisplay = ({
  shareLink,
  onCopy,
  onClose,
}: {
  shareLink: string;
  onCopy: () => void;
  onClose: () => void;
}) => {
  return (
    <div className="flex items-center gap-2 bg-secondary/30 px-3 py-2 rounded-lg border border-secondary animate-in fade-in slide-in-from-top-4">
      <div className="flex items-center gap-2 flex-1">
        <div className="h-2 w-2 bg-green-500 rounded-full animate-pulse" />
        <span className="text-sm font-mono">{shareLink}</span>
      </div>
      <div className="flex items-center gap-1.5">
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 hover:bg-secondary/50 transition-colors"
          onClick={onCopy}
          title="Copy share link"
        >
          <Copy className="h-3.5 w-3.5" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-7 w-7 hover:bg-secondary/50 transition-colors text-muted-foreground"
          onClick={onClose}
          title="Dismiss"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
};

export const ShareLogsButton = ({
  showShareLink = true,
  onComplete,
}: {
  showShareLink?: boolean;
  onComplete?: () => void;
}) => {
  const { toast } = useToast();
  const { copyToClipboard } = useCopyToClipboard({ timeout: 3000 });
  const { settings } = useSettings();
  const [isSending, setIsSending] = useState(false);
  const [shareLink, setShareLink] = useState("");
  const [machineId, setMachineId] = useState("");
  const [feedbackText, setFeedbackText] = useState("");
  const [isLoadingVideo, setIsLoadingVideo] = useState(false);
  const [screenshot, setScreenshot] = useState<string | null>(null);
  const [mergedVideoPath, setMergedVideoPath] = useState<string | null>(null);
  const { health } = useHealthCheck();

  useEffect(() => {
    const loadMachineId = async () => {
      let id: string | null = null;
      try { id = localStorage?.getItem("machineId"); } catch {}
      if (!id) {
        id = crypto.randomUUID();
        try { localStorage?.setItem("machineId", id); } catch {}
      }
      setMachineId(id);
    };
    loadMachineId();
  }, []);

  const getLogFiles = async () => {
    try {
      const result = await commands.getLogFiles();
      if (result.status === "ok") {
        return result.data.map(file => ({
          name: file.name,
          path: file.path,
          modified_at: Number(file.modified_at)
        }));
      } else {
        console.error("failed to get log files:", result.error);
        return [];
      }
    } catch (error) {
      console.error("failed to get log files:", error);
      return [];
    }
  };

  const captureLastFiveMinutes = async () => {
    setIsLoadingVideo(true);
    try {
      // Fetch last video chunks
      const response = await fetch("http://localhost:3030/raw_sql", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: `
            SELECT * FROM video_chunks 
            ORDER BY id DESC
            LIMIT 6
          `,
        }),
      });

      if (!response.ok) throw new Error("failed to fetch video chunks");
      const chunks = (await response.json()) as VideoChunk[];

      // Merge frames
      const mergeResponse = await fetch(
        "http://localhost:3030/experimental/frames/merge",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            video_paths: chunks.map((c) => c.file_path),
          }),
        }
      );

      if (!mergeResponse.ok) throw new Error("failed to merge video chunks");
      const { video_path } = await mergeResponse.json();
      setMergedVideoPath(video_path);
    } catch (err) {
      console.error("failed to capture video:", err);
      toast({
        title: "video capture failed",
        description: "could not record last 5 minutes",
        variant: "destructive",
      });
    } finally {
      setIsLoadingVideo(false);
    }
  };

  const handleScreenshotUpload = async (
    e: React.ChangeEvent<HTMLInputElement>
  ) => {
    try {
      const file = e.target.files?.[0];
      if (!file) return;

      // Convert to data URL for preview
      const reader = new FileReader();
      reader.onload = (e) => {
        setScreenshot(e.target?.result as string);
      };
      reader.readAsDataURL(file);
    } catch (err) {
      console.error("Failed to select screenshot:", err);
    }
  };

  const sendLogs = async () => {
    const logFiles = await getLogFiles();
    if (!logFiles.length) return;

    setIsSending(true);
    try {
      const BASE_URL = "https://screenpi.pe";
      const identifier = settings.user?.id || machineId;
      const type = settings.user?.id ? "user" : "machine";

      // Get log contents - limit to last 100KB per file to avoid OOM
      const MAX_LOG_SIZE = 100 * 1024; // 100KB per file
      const logContents = await Promise.all(
        logFiles.slice(0, 5).map(async (file) => { // Only process 5 most recent logs
          try {
            const content = await readTextFile(file.path);
            // Only keep last MAX_LOG_SIZE characters
            const truncatedContent = content.length > MAX_LOG_SIZE
              ? `... [truncated, showing last ${MAX_LOG_SIZE / 1024}KB] ...\n` + content.slice(-MAX_LOG_SIZE)
              : content;
            return {
              name: file.name,
              content: truncatedContent,
            };
          } catch (e) {
            return { name: file.name, content: `[Error reading file: ${e}]` };
          }
        })
      );

      let consoleLog = "";
      try { consoleLog = (localStorage?.getItem("console_logs") || "").slice(-50000); } catch {} // Last 50KB of console logs

      const signedRes = await fetch(`${BASE_URL}/api/logs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          identifier,
          type,
        }),
      });

      const {
        data: {
          signedUrl,
          path,
          signedUrlScreenshot,
          signedUrlVideo,
          screenshotPath,
          videoPath,
        },
      } = await signedRes.json();

      const combinedLogs =
        logContents
          .map((log) => `\n=== ${log.name} ===\n${log.content}`)
          .join("\n\n") +
        "\n\n=== Browser Console Logs ===\n" +
        consoleLog;

      await fetch(signedUrl, {
        method: "PUT",
        body: combinedLogs,
        headers: { "Content-Type": "text/plain" },
      });

      // Upload screenshot if exists
      if (screenshot && signedUrlScreenshot) {
        // Convert base64 to blob
        const response = await fetch(screenshot);
        const blob = await response.blob();

        // Upload directly using fetch
        await fetch(signedUrlScreenshot, {
          method: "PUT",
          body: blob,
          headers: { "Content-Type": blob.type },
        });
      }

      // Upload video if exists
      if (mergedVideoPath && signedUrlVideo) {
        console.log({
          filePath: mergedVideoPath,
          signedUrl: signedUrlVideo,
        });

        const videoResult = await commands.uploadFileToS3(
          mergedVideoPath,
          signedUrlVideo
        );
        if (videoResult.status !== "ok") throw new Error("Failed to upload video");
      }

      const os = osPlatform();
      const os_version = osVersion();
      const app_version = await getVersion();

      const confirmRes = await fetch(`${BASE_URL}/api/logs/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          path,
          identifier,
          type,
          os,
          os_version,
          app_version,
          feedback_text: feedbackText,
          screenshot_url: screenshotPath,
          video_url: videoPath,
          screenpipe_id: settings.analyticsId,
        }),
      });

      const {
        data: { id },
      } = await confirmRes.json();
      setShareLink(`${BASE_URL}/logs/${id}`);
    } catch (err) {
      console.error("log sharing failed:", err);
      toast({
        title: "sharing failed",
        description: String(err),
        variant: "destructive",
      });
    } finally {
      if (!showShareLink) {
        toast({
          title: "feedback sent",
          description: "thanks for your feedback!",
        });
      }
      if (onComplete) onComplete();
      setIsSending(false);
    }
  };
  return (
    <TooltipProvider>
      <div className="flex flex-col gap-2.5 w-full">
        {!shareLink ? (
          <>
            <Textarea
              placeholder="describe your feedback or issue..."
              value={feedbackText}
              onChange={(e) => setFeedbackText(e.target.value)}
              className="min-h-[60px] resize-none text-xs bg-secondary/5 placeholder:text-muted-foreground/50 focus:border-secondary/30 focus:ring-0 transition-colors"
            />

            <div className="flex flex-wrap items-center gap-2">
              <label className="cursor-pointer flex-none">
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={handleScreenshotUpload}
                  disabled={!!screenshot}
                />
                <Button
                  variant={screenshot ? "secondary" : "outline"}
                  size="sm"
                  className={`gap-1.5 h-7 text-xs transition-all ${
                    screenshot
                      ? "bg-foreground/10 text-foreground"
                      : ""
                  }`}
                  disabled={!!screenshot}
                  asChild
                >
                  <span>
                    <Camera className="h-3 w-3" />
                    <span>screenshot</span>
                  </span>
                </Button>
              </label>

              <Tooltip delayDuration={200}>
                <TooltipTrigger asChild>
                  <Button
                    variant={mergedVideoPath ? "secondary" : "outline"}
                    size="sm"
                    onClick={captureLastFiveMinutes}
                    className={`gap-1.5 h-7 text-xs transition-all ${
                      mergedVideoPath
                        ? "bg-foreground/10 text-foreground"
                        : ""
                    }`}
                    disabled={isLoadingVideo || health?.status === "error"}
                  >
                    {isLoadingVideo ? (
                      <Loader className="h-3 w-3 animate-spin" />
                    ) : (
                      <Video className="h-3 w-3" />
                    )}
                    <span>recording</span>
                    <span className="ml-0.5 text-[10px] text-muted-foreground">
                      5m
                    </span>
                  </Button>
                </TooltipTrigger>
                <TooltipContent
                  side="bottom"
                  className="text-xs"
                >
                  attach last 5 minutes of screen recording
                </TooltipContent>
              </Tooltip>
            </div>

            {screenshot && (
              <div className="relative w-32 aspect-video rounded-lg overflow-hidden bg-secondary/10 border border-border">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={screenshot}
                  alt="Screenshot preview"
                  className="object-cover w-full h-full"
                />
                <Button
                  variant="ghost"
                  size="icon"
                  className="absolute top-1 right-1 h-5 w-5 rounded-full bg-background/80 hover:bg-background/95 border border-border"
                  onClick={() => setScreenshot(null)}
                >
                  <X className="h-2.5 w-2.5" />
                </Button>
              </div>
            )}

            <Button
              variant="default"
              size="sm"
              onClick={sendLogs}
              disabled={isSending}
              className="gap-1.5 h-8 text-xs w-full bg-foreground text-background hover:bg-background hover:text-foreground transition-colors duration-150"
            >
              {isSending ? (
                <>
                  <Loader className="h-3 w-3 animate-spin" />
                  <span>sending...</span>
                </>
              ) : (
                <>
                  <Upload className="h-3 w-3" />
                  <span>send logs & feedback</span>
                </>
              )}
            </Button>
          </>
        ) : (
          <>
            {showShareLink && (
              <ShareLinkDisplay
                shareLink={shareLink}
                onCopy={() => copyToClipboard(shareLink)}
                onClose={() => {
                  setShareLink("");
                  setFeedbackText("");
                  setScreenshot(null);
                  setMergedVideoPath(null);
                }}
              />
            )}
          </>
        )}
      </div>
    </TooltipProvider>
  );
};
