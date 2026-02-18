import React, { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "./ui/dialog";
import { CodeBlock } from "./ui/codeblock";
import { useCopyToClipboard } from "@/lib/hooks/use-copy-to-clipboard";
import { useToast } from "@/components/ui/use-toast";
import { IconCode } from "./ui/icons";
import { getCliPath } from "@/lib/utils";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";
import { platform } from "@tauri-apps/plugin-os";
import { SettingsStore } from "@/lib/utils/tauri";

interface CliCommandDialogProps {
  settings: SettingsStore;
}

export function CliCommandDialog({ settings }: CliCommandDialogProps) {
  const [isOpen, setIsOpen] = useState(false);
  const { copyToClipboard } = useCopyToClipboard({ timeout: 2000 });
  const { toast } = useToast();
  const [isWindows, setIsWindows] = useState(false);

  useEffect(() => {
    const p = platform();
    setIsWindows(p === "windows");
  }, []);

  const generateCliCommand = (
    shell: "cmd" | "powershell" | "bash" = "bash"
  ) => {
    const cliPath = getCliPath();
    let envVars = [];
    let args = [];

    if (settings.useChineseMirror) {
      envVars.push(
        shell === "cmd"
          ? "SET HF_ENDPOINT=https://hf-mirror.com"
          : shell === "powershell"
          ? '$env:HF_ENDPOINT="https://hf-mirror.com"'
          : 'HF_ENDPOINT="https://hf-mirror.com"'
      );
    }

    // Add AI proxy env vars for screenpipe cloud
    if (
      settings.user.cloud_subscribed &&
      settings.realtimeAudioTranscriptionEngine === "screenpipe-cloud" &&
      settings.userId
    ) {
      if (shell === "cmd") {
        envVars.push(
          `SET DEEPGRAM_API_URL=https://api.screenpi.pe/v1/listen`
        );
        envVars.push(
          `SET DEEPGRAM_WEBSOCKET_URL=wss://api.screenpi.pe`
        );
        envVars.push(`SET CUSTOM_DEEPGRAM_API_TOKEN=${settings.userId}`);
      } else if (shell === "powershell") {
        envVars.push(
          `$env:DEEPGRAM_API_URL="https://api.screenpi.pe/v1/listen"`
        );
        envVars.push(
          `$env:DEEPGRAM_WEBSOCKET_URL="wss://api.screenpi.pe"`
        );
        envVars.push(`$env:CUSTOM_DEEPGRAM_API_TOKEN="${settings.userId}"`);
      } else {
        envVars.push(
          `DEEPGRAM_API_URL="https://api.screenpi.pe/v1/listen"`
        );
        envVars.push(
          `DEEPGRAM_WEBSOCKET_URL="wss://api.screenpi.pe"`
        );
        envVars.push(`CUSTOM_DEEPGRAM_API_TOKEN="${settings.userId}"`);
      }

      const quoteChar = shell === "cmd" ? "" : '"';
      args.push(
        `--deepgram-api-key ${quoteChar}${settings.userId}${quoteChar}`
      );
    }

    if (settings.audioTranscriptionEngine !== "default") {
      // TBD hard coded for now
      // if someone wants to use deepgram / screenpipe cloud in CLI mode they'll ask us
      args.push(`--audio-transcription-engine whisper-large-v3-turbo`);
    }
    if (settings.ocrEngine !== "default") {
      args.push(`--ocr-engine ${settings.ocrEngine}`);
    }
    if (
      settings.monitorIds.length > 0 &&
      settings.monitorIds[0] !== "default"
    ) {
      settings.monitorIds.forEach((id) => args.push(`--monitor-id ${id}`));
    }
    if (settings.languages.length > 0) {
      settings.languages.forEach((id) => args.push(`--language ${id}`));
    }
    if (
      settings.audioDevices.length > 0 &&
      settings.audioDevices[0] !== "default"
    ) {
      settings.audioDevices.forEach((device) =>
        args.push(`--audio-device "${device}"`)
      );
    }
    if (settings.usePiiRemoval) {
      args.push("--use-pii-removal");
    }

    if (settings.disableAudio) {
      args.push("--disable-audio");
    }
    settings.ignoredWindows.forEach((window) =>
      args.push(`--ignored-windows "${window}"`)
    );
    settings.includedWindows.forEach((window) =>
      args.push(`--included-windows "${window}"`)
    );
    if (settings.deepgramApiKey && settings.deepgramApiKey !== "default") {
      args.push(`--deepgram-api-key "${settings.deepgramApiKey}"`);
    }
    if (settings.fps !== 0.2) {
      args.push(`--fps ${settings.fps}`);
    }
    if (settings.vadSensitivity !== "high") {
      args.push(`--vad-sensitivity ${settings.vadSensitivity}`);
    }

    if (!settings.analyticsEnabled) {
      args.push("--disable-telemetry");
    }
    if (settings.audioChunkDuration !== 30) {
      args.push(`--audio-chunk-duration ${settings.audioChunkDuration}`);
    }

    if (settings.languages.length > 0) {
      settings.languages.forEach((id) => args.push(`--language ${id}`));
    }

    if (settings.enableInputCapture) {
      args.push("--enable-input-capture");
    }

    if (settings.enableAccessibility) {
      args.push("--enable-accessibility");
    }

    const envVarsStr =
      envVars.length > 0
        ? `${envVars.join(
            shell === "cmd" ? " && " : shell === "powershell" ? "; " : " "
          )} `
        : "";
    const cmdPrefix = shell === "cmd" ? "&& " : "";
    return `${envVarsStr}${cmdPrefix}${cliPath} ${args.join(" ")}`;
  };

  const handleCopyCliCommand = () => {
    const command = generateCliCommand();
    copyToClipboard(command);
    toast({
      title: "CLI command copied",
      description: "The CLI command has been copied to your clipboard.",
    });
  };

  return (
    <>
      <Button variant="outline" size="icon" onClick={() => setIsOpen(true)}>
        <IconCode className="h-4 w-4" />
      </Button>
      <Dialog open={isOpen} onOpenChange={setIsOpen}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>CLI command</DialogTitle>
            <DialogDescription>
              you can use this CLI command to start screenpipe with the current
              settings.
            </DialogDescription>
          </DialogHeader>
          <div className="overflow-x-auto">
            {isWindows ? (
              <Tabs defaultValue="cmd">
                <TabsList>
                  <TabsTrigger value="cmd">cmd</TabsTrigger>
                  <TabsTrigger value="powershell">powershell</TabsTrigger>
                </TabsList>
                <TabsContent value="cmd">
                  <CodeBlock
                    language="bash"
                    value={generateCliCommand("cmd")}
                  />
                </TabsContent>
                <TabsContent value="powershell">
                  <CodeBlock
                    language="powershell"
                    value={generateCliCommand("powershell")}
                  />
                </TabsContent>
              </Tabs>
            ) : (
              <CodeBlock language="bash" value={generateCliCommand("bash")} />
            )}
          </div>
          <DialogFooter>
            <Button onClick={handleCopyCliCommand}>Copy to Clipboard</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
