// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { ComposioRequestError } from "@/lib/composio";

export class SetupConnectionError extends Error {
  constructor(public readonly code: "timeout" | "authentication_required" | "verification_failed" | "invalid_response") {
    super(code);
  }
}

export function connectionFailureProperties(error: unknown, stage: string) {
  if (error instanceof SetupConnectionError) return { error_code: error.code };
  if (error instanceof ComposioRequestError) return { error_code: error.code, http_status: error.httpStatus };
  // Native OAuth returns strings. Match only known causes; never retain the
  // message, which can include provider descriptions, URLs or credentials.
  const message = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  const lower = message.toLowerCase();
  const code = lower.includes("denied or cancelled") ? "authorization_denied"
    : lower.includes("sign-in expired") || lower.includes("timed out") ? "timeout"
    : lower.includes("oauth callbacks require") ? "oauth_configuration"
    : lower.includes("failed to open browser") || stage === "open_oauth" ? "browser_open_failed"
    : lower.includes("token exchange failed") ? "token_exchange_failed"
    : lower.includes("channel closed") ? "cancelled"
    : lower.includes("provider returned error") ? "provider_error"
    : "unknown";
  return { error_code: code };
}
