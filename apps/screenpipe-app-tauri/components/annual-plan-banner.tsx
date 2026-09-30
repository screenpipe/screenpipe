"use client";
// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Loader2 } from "lucide-react";
import { useGT } from "gt-react";
import { Button } from "@/components/ui/button";
import { useSettings } from "@/lib/hooks/use-settings";
import { useManagedPolicy } from "@/lib/hooks/use-managed-policy";
import { openExternalUrl } from "@/lib/open-external-url";
import { tauriFetchWithDeadline } from "@/lib/http/tauri-fetch";
import { screenpipeWebUrl } from "@/lib/web-url";
import { annualOfferDismissalKey, getAnnualPlanOffer, type AnnualPlanOffer } from "@/lib/annual-plan-offer";

const money = (amount: number) => new Intl.NumberFormat(undefined, {
  style: "currency", currency: "USD", maximumFractionDigits: 2,
  minimumFractionDigits: Number.isInteger(amount) ? 0 : 2,
}).format(amount);

export function AnnualPlanBannerView({ offer, onDismiss, onOpened }: {
  offer: AnnualPlanOffer;
  onDismiss: () => void;
  onOpened?: () => void;
}) {
  const ui = useGT();
  const [state, setState] = useState<"idle" | "opening" | "opened" | "error">("idle");
  const opening = useRef(false);

  const reviewAnnual = async () => {
    if (opening.current) return;
    opening.current = true;
    setState("opening");
    try {
      const url = new URL(screenpipeWebUrl("/account/billing", "https://screenpipe.com"));
      url.searchParams.set("target_plan", offer.plan);
      url.searchParams.set("interval", "year");
      await openExternalUrl(url.toString());
      setState("opened");
      onOpened?.();
    } catch {
      setState("error");
    } finally {
      opening.current = false;
    }
  };

  return (
    <section aria-label={ui("Annual billing option")} data-testid="annual-plan-banner"
      className="shrink-0 border-b border-border bg-muted/40 px-5 pb-4 pt-9 text-foreground">
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <div className="min-w-0">
          <p style={{ fontFamily: "var(--font-workflow-heading), system-ui, sans-serif" }} className="text-sm font-semibold">
            {ui("Save {savings} a year with annual billing", { savings: money(offer.savingsAmount) })}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {ui("{amount} billed yearly. Before discounts and taxes. Review before confirming.", { amount: money(offer.annualAmount) })}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-2">
          <Button size="sm" onClick={reviewAnnual} disabled={state === "opening"}
            className="gap-1.5" aria-describedby="annual-billing-status">
            {state === "opening" ? <Loader2 aria-hidden="true" className="h-3.5 w-3.5 animate-spin motion-reduce:animate-none" /> : <ArrowUpRight aria-hidden="true" className="h-3.5 w-3.5" />}
            {state === "opening" ? ui("Opening billing…") : state === "error" ? ui("Try again") : state === "opened" ? ui("Reopen billing") : ui("Switch to annual")}
          </Button>
          <Button size="sm" variant="ghost" onClick={onDismiss}>{ui("Keep monthly")}</Button>
        </div>
      </div>
      <p id="annual-billing-status" role={state === "error" ? "alert" : "status"}
        className={state === "idle" || state === "opening" ? "sr-only" : `mt-2 text-xs leading-relaxed ${state === "error" ? "text-destructive" : "text-muted-foreground"}`}>
        {state === "error" ? ui("Couldn’t open billing. Try again. Your plan hasn’t changed.")
          : state === "opened" ? ui("Billing opened in your browser. Your plan changes only after you confirm there.")
          : ui("Review the final price in your browser before confirming.")}
      </p>
    </section>
  );
}

function EligibleAnnualPlanBanner({ userId, token }: { userId: string; token: string }) {
  const [offer, setOffer] = useState<AnnualPlanOffer | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const refreshOnFocus = useRef(false);

  useEffect(() => {
    let active = true;
    let inFlight = false;
    let lastChecked = 0;
    const controller = new AbortController();
    const check = async () => {
      if (inFlight || (!refreshOnFocus.current && Date.now() - lastChecked < 30_000)) return;
      refreshOnFocus.current = false;
      inFlight = true;
      // Hide stale pricing while revalidating after returning from billing.
      setOffer(null);
      const deadline = new AbortController();
      const abort = () => deadline.abort();
      controller.signal.addEventListener("abort", abort);
      const timeout = setTimeout(abort, 8_000);
      try {
        const read = async (path: string) => {
          const response = await tauriFetchWithDeadline(screenpipeWebUrl(path, "https://screenpipe.com"), {
            headers: { Authorization: `Bearer ${token}` }, signal: deadline.signal,
            cache: "no-store",
          }, { timeoutMs: 8_000 });
          if (!response.ok) throw new Error("Billing unavailable");
          return response.json();
        };
        const [billing, options] = await Promise.all([
          read("/api/billing"), read("/api/subscription/change-plan"),
        ]);
        const next = getAnnualPlanOffer(billing, options);
        if (!active) return;
        let hidden = false;
        if (next) {
          try { hidden = localStorage.getItem(annualOfferDismissalKey(userId, next.subscriptionId)) === "true"; }
          catch { /* A blocked store must not break the app. */ }
        }
        setDismissed(hidden);
        setOffer(next);
      } catch {
        if (active) setOffer(null); // Optional offer: fail quietly, never invent a price.
      } finally {
        clearTimeout(timeout);
        controller.signal.removeEventListener("abort", abort);
        lastChecked = Date.now();
        inFlight = false;
      }
    };
    const onVisible = () => { if (document.visibilityState === "visible") void check(); };
    void check();
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      active = false;
      controller.abort();
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [userId, token]);

  if (!offer || dismissed) return null;
  return <AnnualPlanBannerView offer={offer} onOpened={() => { refreshOnFocus.current = true; }} onDismiss={() => {
    setDismissed(true);
    try { localStorage.setItem(annualOfferDismissalKey(userId, offer.subscriptionId), "true"); }
    catch { /* Still honor the choice for this session. */ }
  }} />;
}

export function AnnualPlanBanner() {
  const { settings } = useSettings();
  const { isManagedDeployment, isManagedDeploymentResolved } = useManagedPolicy();
  const user = settings.user;
  if (!isManagedDeploymentResolved || isManagedDeployment || !user?.id || !user.token ||
    !["standard", "pro"].includes(user.subscription_plan ?? "")) return null;
  return <EligibleAnnualPlanBanner key={`${user.id}:${user.token}`} userId={user.id} token={user.token} />;
}
