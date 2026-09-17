// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";
import { useCallback, useEffect, useState } from "react";
import { localFetch } from "@/lib/api";
import { useSettings } from "@/lib/hooks/use-settings";
import { CONNECTIONS_UPDATED_EVENT, notifyConnectionsUpdated } from "@/lib/connections-events";

type Connection = { key: string; name: string; instance?: string; cloud_available: boolean; pending?: boolean };
/** One default for every supported adapter. Existing credentials require a separate migration. */
export function CloudConnectionAccess() {
  const { settings } = useSettings();
  const [storage, setStorage] = useState("cloud");
  const [available, setAvailable] = useState(false);
  const [connections, setConnections] = useState<Connection[]>([]);
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const signedIn = Boolean(settings.user?.token);
  const load = useCallback(async () => {
    try {
      const response = await localFetch("/connections/cloud");
      if (!response.ok) throw new Error();
      const body = await response.json();
      setStorage(body.storage || "cloud");
      setAvailable(Boolean(body.cloud_available));
      setConnections(body.connections || []);
    } catch { setAvailable(false); }
  }, []);
  useEffect(() => {
    void load();
    window.addEventListener(CONNECTIONS_UPDATED_EVENT, load);
    return () => window.removeEventListener(CONNECTIONS_UPDATED_EVENT, load);
  }, [load, signedIn]);
  async function setDefault(value: string) {
    setBusy(true); setMessage("");
    try {
      const response = await localFetch("/connections/cloud/settings", {method:"PUT", headers:{"Content-Type":"application/json"}, body:JSON.stringify({storage:value})});
      if (!response.ok) throw new Error("Could not change the storage preference.");
      setStorage(value); setConsent(false); setSelected([]);
    } catch (error) {setMessage(error instanceof Error ? error.message : "Could not save the preference.");}
    finally {setBusy(false);}
  }
  async function migrate() {
    if (!consent || !selected.length) return;
    setBusy(true); setMessage("");
    try {
      for (const key of selected) {
        const response = await localFetch("/connections/cloud/share", {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({key,allow_cloud:true})});
        const result = await response.json();
        if (!response.ok || !result.moved) throw new Error(result.error || "Connection setup is incomplete. Retry to finish it.");
        setSelected(items => items.filter(item => item !== key));
      }
      setConsent(false); setSelected([]); setExpanded(false);
      setMessage("Connections are ready on this device and for cloud tasks. Choose which tasks may use them in your workspace.");
      notifyConnectionsUpdated(); await load();
    } catch (error) {setMessage(error instanceof Error ? error.message : "Could not finish connection setup."); await load();}
    finally {setBusy(false);}
  }
  const existing = connections.filter(connection => connection.cloud_available);
  const control = "rounded-md border border-border bg-background px-2 py-1 text-xs disabled:opacity-50";
  return <section aria-label="Connection storage" className="mb-4 space-y-2 text-xs text-muted-foreground">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p>{storage === "local" ? "New connections stay on this device." : signedIn && available ? "Connect once. Use your apps on this device and in cloud tasks." : signedIn ? "Cloud connections are unavailable. New connections stay on this device for now." : "Sign in to use new connections across devices and cloud tasks."}</p>
      <label className="flex items-center gap-2">New connections
        <select aria-label="Storage for new connections" className={control} value={storage} disabled={busy} onChange={event => void setDefault(event.target.value)}>
          <option value="cloud">This device + cloud</option>
          <option value="local">This device only</option>
        </select>
      </label>
    </div>
    {storage === "cloud" && signedIn && available && <p>Supported connection credentials are encrypted in your account. Local apps and files stay on this device. Each cloud task needs its own access grant.</p>}
    {storage === "cloud" && signedIn && available && existing.length > 0 && <button className="text-foreground underline underline-offset-4" onClick={() => setExpanded(!expanded)} aria-expanded={expanded}>Use existing connections in the cloud</button>}
    {expanded && storage === "cloud" && available && <div className="space-y-3 rounded-lg border border-border p-3 text-foreground">
      <p>These connections were saved locally. Select which credentials to move to your encrypted account storage. They will keep working on this device.</p>
      {existing.map(connection => <label key={connection.key} className="flex items-center gap-2"><input type="checkbox" checked={selected.includes(connection.key)} disabled={busy} onChange={event => {setSelected(items => event.target.checked ? [...items,connection.key] : items.filter(key => key !== connection.key)); setConsent(false);}} />{connection.name}{connection.instance ? ` (${connection.instance})` : ""}</label>)}
      <label className="flex items-start gap-2"><input type="checkbox" checked={consent} disabled={busy || !selected.length} onChange={event => setConsent(event.target.checked)} />Move the selected credentials to cloud storage. Stop other devices using old copies before migrating OAuth accounts.</label>
      <button className={control} disabled={busy || !consent || !selected.length} onClick={() => void migrate()}>{busy ? "Setting up…" : "Enable cloud access"}</button>
    </div>}
    {message && <p role="status">{message}</p>}
  </section>;
}
