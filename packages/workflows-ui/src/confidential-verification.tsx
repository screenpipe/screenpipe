// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";
import { useEffect, useRef, useState } from "react";
import { Shield, ShieldCheck, ShieldAlert, X } from "lucide-react";
import { useGT } from "gt-react";

export type VerificationState = "verifying" | "attested" | "response_verified" | "failed";
export type VerificationProof = {
  securityVerified: true; configRepo: string; enclaveHost: string; releaseTag: string;
  codeFingerprint: string; enclaveFingerprint: string; hpkePublicKey: string; verifiedAt: string;
  [key: string]: unknown;
};
export type ConfidentialVerification = { requestId: string; state: VerificationState; document?: VerificationProof };
export type VerificationEnvelope = { sessionId: string; event: Record<string, unknown> };
export type ConfidentialVerificationSource = { subscribe(listener: (value: VerificationEnvelope) => void): Promise<() => void> };
export function parseConfidentialVerification(event: Record<string, unknown>): ConfidentialVerification | null {
  if (event.type !== "extension_ui_request" || event.method !== "setStatus" || (event.statusKey ?? event.key) !== "screenpipe-confidential") return null;
  const text = event.statusText ?? event.text;
  if (typeof text !== "string" || text.length > 16000) return null;
  try {
    const value = JSON.parse(text);
    if (typeof value.requestId !== "string" || value.requestId.length > 100 || !["verifying", "attested", "response_verified", "failed"].includes(value.state)) return null;
    const proof = value.document;
    if (proof !== undefined && (proof.securityVerified !== true || proof.configRepo !== "screenpipe/privacy-filter" || proof.enclaveHost !== "pii.screenpipe.containers.tinfoil.dev" ||
      typeof proof.codeFingerprint !== "string" || !/^[a-f0-9]{64,128}$/i.test(proof.codeFingerprint) || proof.codeFingerprint !== proof.enclaveFingerprint || !/^[a-f0-9]{64}$/i.test(proof.hpkePublicKey) ||
      typeof proof.releaseTag !== "string" || proof.releaseTag.length > 100 || typeof proof.verifiedAt !== "string" || !Number.isFinite(Date.parse(proof.verifiedAt)))) return null;
    if ((value.state === "attested" || value.state === "response_verified") && !proof) return null;
    return { requestId: value.requestId, state: value.state, ...(proof ? { document: proof } : {}) };
  } catch { return null; }
}
const labels = { idle: "Not verified yet", verifying: "Verifying enclave…", attested: "Enclave verified", response_verified: "Encrypted response verified", failed: "Private request failed" };
/** Evidence is live and request-scoped. Never restore a verified badge from disk. */
export function useConfidentialVerification(source?: ConfidentialVerificationSource) {
  const [observed, setObserved] = useState<{ source: typeof source; value: ConfidentialVerification } | null>(null);
  useEffect(() => {
    let disposed = false;
    let request: { sessionId: string; requestId: string } | null = null;
    setObserved(null);
    const subscription = source?.subscribe(({ event, sessionId }) => {
      if (disposed) return;
      const next = parseConfidentialVerification(event);
      if (!next) return;
      if (next.state === "verifying") request = { sessionId, requestId: next.requestId };
      if (request?.sessionId !== sessionId || request.requestId !== next.requestId) return;
      setObserved({ source, value: next });
    });
    void subscription?.catch(() => { if (!disposed) setObserved(null); });
    return () => { disposed = true; void subscription?.then(off => off()).catch(() => {}); };
  }, [source]);
  return observed?.source === source ? observed?.value ?? null : null;
}

export function ConfidentialVerificationBadge({ source }: { source?: ConfidentialVerificationSource }) {
  return <ConfidentialVerificationDetails current={useConfidentialVerification(source)} />;
}

export function ConfidentialVerificationDetails({ current, showLabel = false, triggerRole }: { current: ConfidentialVerification | null; showLabel?: boolean; triggerRole?: "menuitem" }) {
  const ui = useGT();
  const dialog = useRef<HTMLDialogElement>(null);
  const state = current?.state ?? "idle";
  const proof = current?.document;
  const Icon = state === "response_verified" ? ShieldCheck : state === "failed" ? ShieldAlert : Shield;
  const download = () => {
    if (!proof) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify({ requestId: current?.requestId, state, verification: proof }, null, 2)], { type: "application/json" }));
    const anchor = document.createElement("a"); anchor.href = url; anchor.download = "screenpipe-verification.json"; anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  return <span style={{ display: "inline-flex", alignItems: "center" }}>
    <button type="button" role={triggerRole} aria-label={ui("Private AI: {value1}", { value1: labels[state] })} title={labels[state]} onClick={() => dialog.current?.showModal()}
      style={{ display: "inline-flex", alignItems: "center", gap: 8, color: "inherit", background: "transparent", border: showLabel ? 0 : "1px solid currentColor", borderRadius: 6, padding: 5, cursor: "pointer", font: "inherit", textAlign: "left" }}><Icon size={15} aria-hidden="true" />{showLabel && <span>Private AI · {labels[state]}</span>}</button>
    <dialog ref={dialog} aria-label={ui("Private AI verification")} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); dialog.current?.close(); } }} onClick={event => { if (event.target === event.currentTarget) dialog.current?.close(); }}
      style={{ background: "Canvas", color: "CanvasText", colorScheme: "light dark", border: "1px solid GrayText", borderRadius: 8, padding: 24, width: 460, maxWidth: "calc(100vw - 32px)", maxHeight: "80vh", overflow: "auto", font: "inherit", fontSize: 13 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16 }}><strong>Private AI verification</strong><button type="button" aria-label={ui("Close verification")} onClick={() => dialog.current?.close()} style={{ background: "transparent", color: "inherit", border: 0, cursor: "pointer" }}><X size={18} /></button></div>
      <p role="status" style={{ margin: "18px 0 8px" }}><strong>{labels[state]}</strong></p>
      <p style={{ margin: "8px 0 16px" }}>{state === "idle" ? ui("Send a Private request to verify the enclave. Selecting a model alone is not verification.") : state === "verifying" ? ui("Tinfoil is checking the enclave and its encryption key before sending your prompt.") : state === "attested" ? ui("The enclave passed verification. An encrypted response has not completed yet.") : state === "response_verified" ? ui("The latest observed request used Tinfoil encryption. Its response was authenticated and decrypted on this device.") : ui("The request did not complete successfully. It did not fall back to another model or plaintext transport.")}</p>
      <p style={{ margin: "8px 0 16px" }}>Protects model prompts, tool results sent to the model, and responses between this device and the verified enclave. External tools and local files have their own privacy boundaries.</p>
      {proof && <><dl style={{ overflowWrap: "anywhere" }}>{[["Enclave", proof.enclaveHost], ["Release", proof.releaseTag], ["Verified at", proof.verifiedAt], ["Code and enclave measurement", proof.codeFingerprint], ["Attested encryption public key", proof.hpkePublicKey]].map(([name, value]) => <div key={name} style={{ marginBottom: 12 }}><dt style={{ fontWeight: 600 }}>{name}</dt><dd style={{ margin: 0, fontFamily: "monospace", fontSize: 12 }}>{value}</dd></div>)}</dl>
        <a href={`https://github.com/screenpipe/privacy-filter/releases/tag/${encodeURIComponent(proof.releaseTag)}`} target="_blank" rel="noreferrer">Inspect verified release</a>
        <button type="button" onClick={download} style={{ display: "block", marginTop: 16, padding: "6px 10px", border: "1px solid currentColor", borderRadius: 6, background: "transparent", color: "inherit", cursor: "pointer" }}>Download verification evidence</button></>}
    </dialog>
  </span>;
}
