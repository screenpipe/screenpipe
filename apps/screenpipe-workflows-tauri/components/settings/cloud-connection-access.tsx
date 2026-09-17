// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";
import { useState } from "react";
import { localFetch } from "@/lib/api";
import { useSettings } from "@/lib/hooks/use-settings";
import { screenpipeWebUrl } from "@/lib/web-url";
import { notifyConnectionsUpdated } from "@/lib/connections-events";

type Connection = { key: string; name: string; instance?: string; cloud_available: boolean; rotating_credentials: boolean };
/** The shared inventory comes from native adapters, so new providers need no UI allowlist. */
export function CloudConnectionAccess() {
  const { settings } = useSettings();
  const [connections, setConnections] = useState<Connection[]>([]);
  const [workspaces, setWorkspaces] = useState<{ id: string; org_name: string }[]>([]);
  const [selected, setSelected] = useState("");
  const [workspace, setWorkspace] = useState("");
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  async function load() {
    setBusy(true);
    try {
      const token = settings.user?.token;
      if (!token) throw new Error("Sign in before moving a connection to the cloud.");
      const [local, remote] = await Promise.all([
        localFetch("/connections/cloud"),
        fetch(screenpipeWebUrl("/api/enterprise/cloud-connections/workspaces", "https://screenpipe.com"), { headers: { Authorization: `Bearer ${token}` } }),
      ]);
      if (!local.ok || !remote.ok) throw new Error("Could not load cloud access. Check your connection and app version.");
      setConnections((await local.json()).connections);
      setWorkspaces((await remote.json()).workspaces);
      setMessage("");
    } catch (error) { setMessage(error instanceof Error ? error.message : "Cloud access unavailable."); }
    finally { setBusy(false); }
  }
  async function move() {
    setBusy(true);
    try {
      const result = await localFetch("/connections/cloud/share", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ key: selected, license_id: workspace, token: settings.user?.token, allow_cloud: consent }),
      });
      const receipt = await result.json();
      if (!result.ok) throw new Error(receipt.error || "Could not move the connection.");
      setConsent(false);
      if (receipt.local_cleanup_required) {
        setMessage("Saved in the cloud, but the local copy could not be removed. Disconnect it locally before enabling cloud tasks.");
      } else {
        setConnections(items => items.filter(item => item.key !== selected));
        setSelected("");
        notifyConnectionsUpdated();
        setMessage("Moved to cloud storage. Choose which tasks may use it in the workspace’s Machines → Cloud connections page.");
      }
    } catch (error) { setMessage(error instanceof Error ? error.message : "Could not move the connection."); }
    finally { setBusy(false); }
  }
  const active = connections.find(item => item.key === selected);
  const control = "border border-border bg-background p-2 text-xs disabled:opacity-50";
  return <details className="border border-border p-3 space-y-3" onToggle={event => { if (event.currentTarget.open) void load(); }}>
    <summary className="text-sm cursor-pointer">Cloud access</summary>
    <p className="text-xs text-muted-foreground">Keep connections local, or move them to your workspace so cloud tasks can run while this computer is off. Cloud credentials are encrypted and accessible to the trusted workspace runner.</p>
    <div className="flex flex-wrap gap-2">
      <select aria-label="Connection to move" className={control} value={selected} onChange={event => { setSelected(event.target.value); setConsent(false); }}>
        <option value="">Select a connection</option>
        {connections.map(item => <option key={item.key} value={item.key}>{item.name}{item.instance ? ` (${item.instance})` : ""}{item.cloud_available ? "" : " · requires local environment"}</option>)}
      </select>
      <select aria-label="Cloud workspace" className={control} value={workspace} onChange={event => { setWorkspace(event.target.value); setConsent(false); }}>
        <option value="">Select a workspace</option>
        {workspaces.map(item => <option key={item.id} value={item.id}>{item.org_name}</option>)}
      </select>
    </div>
    {active && !active.cloud_available && <p className="text-xs">This connection depends on local files, a desktop app, or a local process. Use a device-targeted task for this connection.</p>}
    {active?.cloud_available && <label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={consent} onChange={event => setConsent(event.target.checked)} />Move this connection to cloud storage and remove it from this device. Stop using other copies before moving OAuth accounts so only the cloud runner refreshes their tokens.</label>}
    <button className={control} disabled={busy || !consent || !workspace || !active?.cloud_available} onClick={move}>Move to cloud</button>
    <p role="status" className="text-xs">{message}</p>
  </details>;
}
