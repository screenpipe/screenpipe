// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";

import { screenpipeWebUrl, PROD_WEB_BASE } from "@/lib/web-url";
import { useState } from "react";
import { ExternalLink, Loader2 } from "lucide-react";
import { CloudAiConnectionCard } from "@/components/cloud-ai-connection-card";
import { Switch } from "@/components/ui/switch";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";

type Props = {
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

export function AccountDataSyncCard(props: Props) {
  const [openError, setOpenError] = useState(false);
  return (
    <div className="space-y-4" data-testid="account-data-sync-setting">
      <section
        className="space-y-4 rounded-lg border bg-card p-5 text-card-foreground"
        aria-labelledby="data-sync-heading"
      >
        <div className="flex items-center justify-between gap-4">
          <h2 id="data-sync-heading" className="text-sm font-medium">
            Data sync
          </h2>
          <p
            role="status"
            className="flex items-center gap-2 text-xs text-muted-foreground"
          >
            {props.saving && (
              <Loader2 className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" />
            )}
            {props.saving
              ? "Saving…"
              : props.enabled
                ? "On for this device"
                : "Off for this device"}
          </p>
        </div>
        <div className="flex items-center justify-between gap-4">
          <div className="space-y-1">
            <Label htmlFor="data-sync-toggle">Sync this device</Label>
            <p id="data-sync-description" className="text-xs text-muted-foreground">
              Upload this device’s history to your Screenpipe account to search
              it across devices and connected AI apps.
            </p>
          </div>
          <Switch
            id="data-sync-toggle"
            aria-label="Sync this device"
            aria-describedby="data-sync-description data-sync-setup"
            checked={props.enabled}
            disabled={props.saving}
            onCheckedChange={(value) => void props.onEnabledChange(value)}
          />
        </div>
        <p id="data-sync-setup" className="text-xs text-muted-foreground">
          Turning this on enables sync for your account and this device. Turn it
          on in the app on each device you want to sync.
        </p>
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
        <div className="space-y-2 border-t pt-3">
          <p className="text-xs text-muted-foreground">
            Turning sync off stops new uploads from this device. Data already
            synced stays in your account until you delete it.
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
      </section>
      <CloudAiConnectionCard
        enabled={props.enabled}
        busy={props.saving}
        onEnable={() => props.onEnabledChange(true)}
        onOpenExternal={props.onOpenExternal}
        onConfigureClient={props.onConfigureClient}
        device
      />
    </div>
  );
}
