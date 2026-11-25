// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import * as Sentry from "@sentry/react";

/**
 * Client-side error tracking for the workflows web host.
 *
 * This app shipped with no error monitoring: the desktop host of the same
 * WorkflowsApp UI reports through the screenpipe-app Sentry project, but
 * failures in the web host (enterprise workflows entry point) were invisible.
 * This file runs in the browser bundle on every page load.
 *
 * Static export: there is no server runtime here — the host website owns the
 * API routes — so only the browser bundle is instrumented. It stays a no-op
 * until NEXT_PUBLIC_SENTRY_DSN is provided at build time.
 */
const dsn = process.env.NEXT_PUBLIC_SENTRY_DSN;

if (dsn) {
  Sentry.init({
    dsn,
    environment: process.env.NEXT_PUBLIC_SENTRY_ENVIRONMENT ?? "production",
    release: process.env.NEXT_PUBLIC_SENTRY_RELEASE,
    // Errors only; no performance traces and no PII from this surface.
    tracesSampleRate: 0,
    sendDefaultPii: false,
  });
} else if (process.env.NODE_ENV !== "production") {
  console.warn(
    "NEXT_PUBLIC_SENTRY_DSN is not set — workflows web error tracking is disabled"
  );
}
