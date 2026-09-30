// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterEach, expect, it } from "vitest";
import { act, cleanup, render, screen } from "@testing-library/react";
import { ConfidentialVerificationBadge, parseConfidentialVerification, type VerificationEnvelope, type ConfidentialVerificationSource } from "@screenpipe/workflows-ui";
afterEach(cleanup);
const proof = { securityVerified: true, configRepo: "screenpipe/privacy-filter", enclaveHost: "pii.screenpipe.containers.tinfoil.dev", releaseTag: "v0.9.9", codeFingerprint: "a".repeat(96), enclaveFingerprint: "a".repeat(96), hpkePublicKey: "b".repeat(64), verifiedAt: "2026-09-18T15:29:52Z" };
const event = (state: string, requestId = "a", document: unknown = proof) => ({ type: "extension_ui_request", method: "setStatus", key: "screenpipe-confidential", text: JSON.stringify({ state, requestId, ...(state === "verifying" ? {} : { document }) }) });
it("requires matching attestation evidence for a verified state", () => {
  expect(parseConfidentialVerification(event("response_verified"))?.state).toBe("response_verified");
  for (const document of [null, { ...proof, securityVerified: false }, { ...proof, enclaveFingerprint: "c".repeat(96) }, { ...proof, hpkePublicKey: "bad" }, { ...proof, configRepo: "untrusted/repo" }]) expect(parseConfidentialVerification(event("response_verified", "a", document))).toBeNull();
  expect(parseConfidentialVerification({ ...event("attested"), text: JSON.stringify({ requestId: "a", state: "attested" }) })).toBeNull();
  expect(parseConfidentialVerification({ ...event("attested"), type: "message_update" })).toBeNull();
});
it("starts unverified, follows this request, ignores stale results, and clears on source change", async () => {
  let receive!: (value: VerificationEnvelope) => void;
  const source: ConfidentialVerificationSource = { subscribe: async listener => { receive = listener; return () => {}; } };
  const view = render(<ConfidentialVerificationBadge source={source} />);
  expect(screen.getByRole("button", { name: "Private AI: Not verified yet" })).toBeTruthy();
  const send = (state: string, id = "a", sessionId = "session") => act(() => receive({ sessionId, event: event(state, id) }));
  send("response_verified");
  expect(screen.getByRole("button", { name: "Private AI: Not verified yet" })).toBeTruthy();
  send("verifying"); send("attested");
  expect(screen.getByRole("button", { name: "Private AI: Enclave verified" })).toBeTruthy();
  send("response_verified");
  expect(screen.getByRole("button", { name: "Private AI: Encrypted response verified" })).toBeTruthy();
  send("verifying", "b"); send("response_verified", "a"); send("response_verified", "b", "other-session");
  expect(screen.getByRole("button", { name: "Private AI: Verifying enclave…" })).toBeTruthy();
  send("failed", "b");
  expect(screen.getByRole("button", { name: "Private AI: Private request failed" })).toBeTruthy();
  view.rerender(<ConfidentialVerificationBadge source={{ subscribe: async () => () => {} }} />);
  expect(screen.getByRole("button", { name: "Private AI: Not verified yet" })).toBeTruthy();
});
