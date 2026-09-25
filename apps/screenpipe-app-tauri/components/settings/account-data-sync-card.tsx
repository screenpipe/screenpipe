// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";

import { screenpipeWebUrl, PROD_WEB_BASE } from "@/lib/web-url";
import { useState } from "react";
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
    <div data-testid="account-data-sync-setting">
      <CloudAiConnectionCard
        enabled={props.enabled}
        busy={props.saving}
        error={props.error}
        onEnable={() => props.onEnabledChange(true)}
        onRetry={props.onRetry}
        onOpenExternal={props.onOpenExternal}
        onConfigureClient={props.onConfigureClient}
        device
      >
        <div className="flex items-center justify-between gap-4">
          <div>
            <p className="text-sm font-medium">Sync this device</p>
            <p className="text-xs text-muted-foreground">
              Upload this device’s history to your Screenpipe account.
            </p>
          </div>
          <Switch
            id="data-sync-toggle"
            aria-label="Sync this device"
            checked={props.enabled}
            disabled={props.saving}
            onCheckedChange={(value) => void props.onEnabledChange(value)}
          />
        </div>
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
        <Button
          variant="link"
          className="h-auto p-0 text-xs"
          onClick={() =>
            void props
              .onOpenExternal(screenpipeWebUrl("/account", PROD_WEB_BASE))
              .then(() => setOpenError(false))
              .catch(() => setOpenError(true))
          }
        >
          Manage account cloud data
        </Button>
        {openError && (
          <p role="alert" className="text-xs text-destructive">
            Could not open account settings. Open screenpipe.com/account in your
            browser.
          </p>
        )}
      </CloudAiConnectionCard>
    </div>
  );
}
