// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";

import { screenpipeWebUrl, PROD_WEB_BASE } from "@/lib/web-url";
import { useState, type ReactNode } from "react";
import { useGT } from "gt-react";
import { ExternalLink, Loader2, RefreshCw } from "lucide-react";
import { CloudAiConnectionCard } from "@/components/cloud-ai-connection-card";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";

type HistorySyncProps = {
  enabled: boolean;
  saving: boolean;
  error: string | null;
  onRetry: () => void;
  onEnabledChange: (enabled: boolean) => Promise<boolean>;
  deviceName: string;
  onDeviceNameChange: (name: string) => void;
  devices: { device_id: string; device_name: string; last_synced_at: string }[];
  devicesLoading: boolean;
  devicesError: boolean;
  onRetryDevices: () => void;
  locale: string;
  onOpenExternal: (url: string) => Promise<void>;
  onConfigureClient: (client: "codex" | "claude-code") => Promise<void>;
};

export function AccountDataSyncCard({
  history,
  children,
}: {
  history?: HistorySyncProps;
  children?: ReactNode;
}) {
  const ui = useGT();
  return (
    <div className="space-y-4" data-testid="account-data-sync-setting">
      <section
        className="space-y-4 rounded-lg border bg-card p-5 text-card-foreground"
        aria-labelledby="data-sync-heading"
      >
        <h2 id="data-sync-heading" className="text-sm font-medium">
          {ui("Data sync")}
        </h2>
        {history && <DeviceHistorySync {...history} />}
        {children}
      </section>
      {history && (
        <CloudAiConnectionCard
          enabled={history.enabled}
          busy={history.saving}
          onEnable={() => history.onEnabledChange(true)}
          onOpenExternal={history.onOpenExternal}
          onConfigureClient={history.onConfigureClient}
          device
        />
      )}
    </div>
  );
}

function DeviceHistorySync(props: HistorySyncProps) {
  const ui = useGT();
  const [openError, setOpenError] = useState(false);
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-4">
        <div className="space-y-1">
          <Label htmlFor="data-sync-toggle" className="font-sans">
            {ui("Upload history from this device")}
          </Label>
          <p id="data-sync-description" className="text-xs text-muted-foreground">
            {ui("Search this device’s history across devices and connected AI apps. Uploads include periodic screenshot thumbnails.")}
          </p>
        </div>
        <Switch
          id="data-sync-toggle"
          className="shrink-0"
          aria-describedby="data-sync-description"
          checked={props.enabled}
          disabled={props.saving}
          onCheckedChange={(value) => void props.onEnabledChange(value)}
        />
      </div>
      {props.saving && (
        <p role="status" className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
          {ui("Saving…")}
        </p>
      )}
      {props.error && (
        <div role="alert" className="space-y-2 text-sm text-destructive">
          <p>{props.error}</p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={props.saving}
            onClick={props.onRetry}
          >
            Try again
          </Button>
        </div>
      )}
      {props.enabled && (
        <div className="space-y-3 border-t pt-4">
          <Label htmlFor="data-sync-device-name">Device name</Label>
          <Input
            id="data-sync-device-name"
            maxLength={96}
            value={props.deviceName}
            onChange={(event) => props.onDeviceNameChange(event.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Ask your AI about this device by name.
          </p>
          <div className="space-y-2">
            <p className="text-sm font-medium">Synced devices</p>
            {props.devicesLoading ? (
              <p role="status" className="text-xs text-muted-foreground">
                Checking synced devices…
              </p>
            ) : props.devicesError ? (
              <div role="alert" className="space-y-2">
                <p className="text-xs text-destructive">
                  Could not load synced devices.
                </p>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={props.onRetryDevices}
                >
                  Retry devices
                </Button>
              </div>
            ) : props.devices.length === 0 ? (
              <p className="text-xs text-muted-foreground">
                Waiting for the first upload. Keep Screenpipe running.
              </p>
            ) : (
              props.devices.map((device) => (
                <div
                  key={device.device_id}
                  className="flex flex-wrap justify-between gap-x-3 gap-y-1 text-xs"
                >
                  <span className="break-words font-medium">
                    {device.device_name}
                  </span>
                  <span className="text-muted-foreground">
                    Last upload{" "}
                    {new Date(device.last_synced_at).toLocaleString(
                      props.locale,
                    )}
                  </span>
                </div>
              ))
            )}
          </div>
        </div>
      )}
      <div className="space-y-2">
        <p className="text-xs text-muted-foreground">
          {ui("Turn this on for each device you want to upload from. Turning it off stops new uploads. Previously uploaded history stays in your account until you delete it.")}
        </p>
        <Button
          variant="link"
          className="h-auto whitespace-normal p-0 text-left text-xs"
          onClick={() =>
            void props
              .onOpenExternal(screenpipeWebUrl("/account", PROD_WEB_BASE))
              .then(() => setOpenError(false))
              .catch(() => setOpenError(true))
          }
        >
          Manage or delete cloud data on website
          <ExternalLink className="ml-1.5 h-3 w-3 shrink-0" />
        </Button>
      </div>
      {openError && (
        <p role="alert" className="text-xs text-destructive">
          Could not open account settings. Open screenpipe.com/account in your
          browser.
        </p>
      )}
    </div>
  );
}

export function SyncPreferenceRow({
  id,
  label,
  description,
  enabled,
  onEnabledChange,
  onSync,
  isServerDown,
}: {
  id: string;
  label: string;
  description?: string;
  enabled: boolean;
  onEnabledChange: (checked: boolean) => Promise<void>;
  onSync: () => Promise<void>;
  isServerDown: boolean;
}) {
  const ui = useGT();
  const [syncing, setSyncing] = useState(false);
  return (
    <div className="flex items-start justify-between gap-4">
      <div>
        <Label htmlFor={id} className="font-sans">{label}</Label>
        {description && (
          <p id={`${id}-description`} className="text-xs text-muted-foreground">{description}</p>
        )}
        {enabled && (
          <Button
            variant="link"
            size="sm"
            className="mt-1 flex h-auto p-0 text-xs"
            aria-label={ui("Sync now: {label}", { label })}
            title={isServerDown ? ui("Screenpipe server is starting up. Try again in a moment.") : undefined}
            disabled={syncing || isServerDown}
            onClick={async () => {
              setSyncing(true);
              try {
                await onSync();
              } finally {
                setSyncing(false);
              }
            }}
          >
            <RefreshCw aria-hidden="true" className={`mr-1 h-3 w-3 ${syncing ? "animate-spin motion-reduce:animate-none" : ""}`} />
            {ui("Sync now")}
          </Button>
        )}
      </div>
      <Switch
        id={id}
        className="shrink-0"
        aria-describedby={description ? `${id}-description` : undefined}
        checked={enabled}
        onCheckedChange={onEnabledChange}
      />
    </div>
  );
}
