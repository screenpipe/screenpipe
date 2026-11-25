// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

type CallApi = (endpoint: string) => Promise<Response>;

export type DataSyncToolResult = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

const DEFAULT_SYNCED_TEXT_CAP = 1000;

function truncateMiddle(text: string, max: number): string {
  if (max <= 0 || text.length <= max) return text;
  const halfLeft = Math.floor(max / 2);
  const halfRight = max - halfLeft;
  const cut = text.length - max;
  return (
    text.slice(0, halfLeft) +
    `…[${cut} chars truncated — pass max_content_length=0 for full text]…` +
    text.slice(text.length - halfRight)
  );
}

function parseErrorCode(error: unknown): { status?: number; code?: string } {
  if (typeof error !== "object" || error === null) return {};
  const record = error as { status?: unknown; bodyText?: unknown; body?: unknown };
  const status = typeof record.status === "number" ? record.status : undefined;
  const rawBody =
    typeof record.bodyText === "string"
      ? record.bodyText
      : typeof record.body === "string"
        ? record.body
        : "";

  let code: string | undefined;
  if (rawBody) {
    try {
      const parsed = JSON.parse(rawBody) as { error?: unknown; code?: unknown };
      if (typeof parsed.error === "string") code = parsed.error;
      else if (typeof parsed.code === "string") code = parsed.code;
    } catch {
      // Non-JSON body; inspect only exact known error codes below.
    }
  }
  return { status, code };
}

function dataSyncUnavailableMessage(error: unknown): string | undefined {
  const { status, code } = parseErrorCode(error);
  if (status === 403 && code === "data_sync_disabled") {
    return (
      "Data Sync is off and no synced devices are available. " +
      "Enable Data Sync in Screenpipe settings on the devices you want to query. " +
      "For the current machine, use search-content or activity-summary."
    );
  }
  if (status === 503 && code === "cloud_token_missing") {
    return (
      "Data Sync is unavailable because Screenpipe is not signed in to a cloud account. " +
      "Sign in and enable Data Sync in Screenpipe settings to query other devices. " +
      "For the current machine, use search-content or activity-summary."
    );
  }
  return undefined;
}

export async function handleSyncedDevices(
  callApi: CallApi,
): Promise<DataSyncToolResult> {
  let response: Response;
  try {
    response = await callApi("/data-sync/devices");
  } catch (error) {
    const guidance = dataSyncUnavailableMessage(error);
    if (guidance) {
      return { content: [{ type: "text", text: guidance }] };
    }
    throw error;
  }

  const data = (await response.json()) as {
    enabled?: boolean;
    devices?: Array<{
      device_name?: string;
      device_id?: string;
      last_synced_at?: string;
      platform?: string;
    }>;
  };
  const devices = Array.isArray(data.devices) ? data.devices : [];
  if (devices.length === 0) {
    return {
      content: [
        {
          type: "text",
          text:
            data.enabled === false
              ? "Data Sync is off and no synced devices are available. Enable Data Sync in Screenpipe settings on the devices you want to query. For the current machine, use search-content or activity-summary."
              : "No synced devices are available yet. Enable Data Sync and let a device complete its first upload.",
        },
      ],
    };
  }

  return {
    content: [
      {
        type: "text",
        text: devices
          .map(
            (device) =>
              `${device.device_name} (${device.device_id}) — last synced ${device.last_synced_at}` +
              `${device.platform ? ` — ${device.platform}` : ""}`,
          )
          .join("\n"),
      },
    ],
  };
}

export async function handleSearchSyncedContent(
  args: Record<string, unknown>,
  callApi: CallApi,
): Promise<DataSyncToolResult> {
  const params = new URLSearchParams();
  for (const key of [
    "q",
    "device_name",
    "device_id",
    "app_name",
    "since",
    "until",
    "since_hours_ago",
    "limit",
  ]) {
    const value = args[key];
    if (value !== null && value !== undefined && value !== "") {
      params.set(key, String(value));
    }
  }

  let response: Response;
  try {
    response = await callApi(`/data-sync/search?${params.toString()}`);
  } catch (error) {
    const guidance = dataSyncUnavailableMessage(error);
    if (guidance) {
      return { content: [{ type: "text", text: guidance }] };
    }
    throw error;
  }

  const data = (await response.json()) as {
    enabled?: boolean;
    truncated?: boolean;
    results?: Array<{
      device?: string;
      device_id?: string;
      t?: string;
      app?: string;
      text?: string;
      transcription?: string;
      content?: string;
    }>;
  };
  const results = Array.isArray(data.results) ? data.results : [];
  if (results.length === 0) {
    return {
      content: [
        {
          type: "text",
          text:
            data.enabled === false
              ? "No matching synced records. Data Sync is currently off, so no new records are uploading. For the current machine, use search-content or activity-summary."
              : "No matching synced records. Try a wider time range, confirm the device with synced-devices, or use a broader query.",
        },
      ],
    };
  }

  const prefix = data.truncated
    ? "Results are truncated; narrow the device, time range, or query.\n\n"
    : "";
  return {
    content: [
      {
        type: "text",
        text:
          prefix +
          results
            .map((record) => {
              const content =
                record.text || record.transcription || record.content || "";
              return (
                `[${record.device || record.device_id || "unknown device"}] ${record.t || "unknown time"}` +
                `${record.app ? ` — ${record.app}` : ""}\n${truncateMiddle(String(content), DEFAULT_SYNCED_TEXT_CAP)}`
              );
            })
            .join("\n\n"),
      },
    ],
  };
}
