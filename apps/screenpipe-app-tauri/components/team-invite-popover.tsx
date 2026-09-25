// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

"use client";

import { useEffect, useRef, useState, type ReactElement } from "react";
import { ArrowUpRight, ArrowRight, Loader2, Check } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { screenpipeWebUrl } from "@/lib/web-url";
import type { TeamEntry } from "@/lib/hooks/use-team-summary";

type SeatQuote = {
  quote_token: string;
  team_name: string;
  from: number;
  to: number;
  amount_due_today: number;
  new_total: number;
  currency: string;
  interval: string;
  interval_count: number;
};
const money = (amount: number, currency: string) =>
  new Intl.NumberFormat(undefined, { style: "currency", currency }).format(
    amount,
  );

type Result = { kind: "sent" | "error" | "uncertain"; message: string } | null;
export function TeamInvitePopover({
  entry,
  token,
  onManage,
  children,
}: {
  entry: TeamEntry;
  token?: string | null;
  onManage: () => void;
  children: ReactElement;
}) {
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [quote, setQuote] = useState<SeatQuote | null>(null);
  const [purchasing, setPurchasing] = useState(false);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<Result>(null);
  const input = useRef<HTMLInputElement>(null);
  const pending = useRef<AbortController | null>(null);
  const canInvite = Boolean(entry.canInvite && entry.teamId && token);
  useEffect(
    () => () => {
      const request = pending.current;
      pending.current = null;
      request?.abort();
    },
    [],
  );

  async function invite(event?: React.FormEvent, purchase?: SeatQuote) {
    event?.preventDefault();
    if (quote && !purchase) return;
    if (!canInvite || pending.current || result?.kind === "uncertain") return;
    const recipient = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient)) {
      setResult({ kind: "error", message: "Enter a valid email address." });
      return;
    }
    const controller = new AbortController();
    pending.current = controller;
    const timer = setTimeout(
      () => controller.abort(),
      purchase ? 45000 : 15000,
    );
    setSending(true);
    setResult(null);
    setPurchasing(Boolean(purchase));
    setQuote(null);
    let seatPurchased = false;
    const endpoint = screenpipeWebUrl(
      `/api/team/billing/add-seat?team_id=${encodeURIComponent(entry.teamId!)}`,
      "https://screenpipe.com",
    );
    const headers = {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    };
    try {
      if (purchase) {
        const response = await fetch(endpoint, {
          method: "POST",
          headers,
          body: JSON.stringify(purchase),
          signal: controller.signal,
        });
        const data = await response.json();
        if (pending.current !== controller || controller.signal.aborted) return;
        if (!response.ok) {
          setResult({
            kind: "uncertain",
            message:
              data.error ||
              "Check team billing on the web before trying again.",
          });
          return;
        }
        if (data.purchased !== true || data.seats !== purchase.to)
          throw new Error("uncertain");
        seatPurchased = true;
        setPurchasing(false);
      }
      const response = await fetch(
        screenpipeWebUrl(
          `/api/team/billing/seat-invite?team_id=${encodeURIComponent(entry.teamId!)}`,
          "https://screenpipe.com",
        ),
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ email: recipient }),
          signal: controller.signal,
        },
      );
      const data = await response.json();
      if (pending.current !== controller || controller.signal.aborted) return;
      if (!response.ok) {
        if (data.code === "NO_AVAILABLE_SEATS" && !purchase) {
          const priceResponse = await fetch(endpoint, {
            headers,
            signal: controller.signal,
          });
          const price = await priceResponse.json();
          if (pending.current !== controller || controller.signal.aborted)
            return;
          if (!priceResponse.ok) {
            setResult({
              kind: "error",
              message: price.error || "Review seat pricing on the web.",
            });
          } else if (
            typeof price.quote_token === "string" &&
            Number.isFinite(price.amount_due_today) &&
            Number.isFinite(price.new_total) &&
            /^[a-z]{3}$/i.test(price.currency) &&
            ["month", "year", "week", "day"].includes(price.interval) &&
            price.to === price.from + 1 &&
            price.interval_count > 0
          ) {
            setQuote(price);
          } else
            setResult({
              kind: "error",
              message:
                "Could not verify seat pricing. Manage billing on the web.",
            });
          return;
        }
        if (seatPurchased) {
          setResult({
            kind: "uncertain",
            message:
              "The seat was purchased, but the invitation was not confirmed. Check invitations on the web; do not buy another seat.",
          });
          return;
        }
        // A server error can occur after the invite was created. Never replay it.
        if (response.status >= 500) throw new Error("uncertain");
        setResult({
          kind: "error",
          message:
            data.error ||
            "Could not invite this person. Manage your team on the web.",
        });
        return;
      }
      if (!data.invite || data.invite.email?.toLowerCase() !== recipient)
        throw new Error("uncertain");
      if (data.email_sent === true) {
        setResult({ kind: "sent", message: `Invite sent to ${recipient}` });
        setEmail("");
      } else {
        setResult({
          kind: "uncertain",
          message:
            "Invite created. Email delivery couldn’t be confirmed. Open your team on the web to share the invite link.",
        });
      }
    } catch {
      if (pending.current === controller)
        setResult({
          kind: "uncertain",
          message:
            purchase && !seatPurchased
              ? "We couldn’t confirm the purchase. Check team billing on the web before trying again."
              : "We couldn’t confirm delivery. Check invitations on the web before sending again.",
        });
    } finally {
      clearTimeout(timer);
      if (pending.current === controller) {
        pending.current = null;
        setSending(false);
        setPurchasing(false);
      }
    }
  }

  const explanation =
    entry.kind === "signed-out"
      ? "Sign in on the web to invite your team."
      : entry.kind === "no-team"
        ? "Start a Business team on the web. Review the total for you and your teammate before paying. Your team pays; your teammate won’t need a card."
        : entry.kind === "enterprise"
          ? "Invite people through your organization’s member settings."
          : entry.kind === "unavailable"
            ? "Open your team on the web to check access and invitations."
            : "Email invitations require a team admin and a paid team seat.";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>{children}</PopoverTrigger>
      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-80 max-w-[calc(100vw-24px)] space-y-3 rounded-lg p-4"
        aria-label="Invite your team"
        onOpenAutoFocus={(event) => {
          if (canInvite) {
            event.preventDefault();
            input.current?.focus();
          }
        }}
      >
        <div className="space-y-1">
          <h2 className="text-sm font-medium">Invite a teammate</h2>
          {entry.kind === "team" || entry.kind === "enterprise" ? (
            <p
              className="truncate text-xs text-muted-foreground"
              title={entry.label}
            >
              {entry.label}
            </p>
          ) : null}
        </div>
        {canInvite ? (
          <form onSubmit={invite} className="space-y-2">
            <div className="flex gap-2">
              <label htmlFor="quick-team-email" className="sr-only">
                Teammate email
              </label>
              <input
                ref={input}
                id="quick-team-email"
                aria-label="Teammate email"
                type="email"
                autoComplete="email"
                placeholder="teammate@company.com"
                required
                value={email}
                onChange={(event) => {
                  setEmail(event.target.value);
                  if (result?.kind !== "uncertain") setResult(null);
                }}
                disabled={
                  sending || Boolean(quote) || result?.kind === "uncertain"
                }
                className="h-9 min-w-0 flex-1 rounded-md border border-input bg-transparent px-2.5 text-xs outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-50"
              />
              <button
                type="submit"
                aria-label="Send invitation"
                title="Send invitation"
                disabled={
                  sending ||
                  Boolean(quote) ||
                  !email.trim() ||
                  result?.kind === "uncertain"
                }
                className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md bg-primary text-primary-foreground disabled:opacity-40"
              >
                {sending ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <ArrowRight className="h-4 w-4" />
                )}
              </button>
            </div>
            <p className="text-[11px] text-muted-foreground">
              {sending
                ? purchasing
                  ? "Adding the paid seat…"
                  : "Sending invitation…"
                : "Your team pays. Invites use an existing seat; adding a seat requires price confirmation."}
            </p>
          </form>
        ) : (
          <p className="text-xs leading-relaxed text-muted-foreground">
            {explanation}
          </p>
        )}
        {quote && (
          <div
            className="space-y-3 rounded-md border p-3"
            aria-label="Confirm additional paid seat"
          >
            <p className="text-sm font-medium">Add a seat to {entry.label}</p>
            <p className="text-xs text-muted-foreground">
              {quote.from} → {quote.to} paid seats. Your teammate won’t need to
              pay for this seat.
            </p>
            <dl className="space-y-1 text-xs">
              <div className="flex justify-between gap-2">
                <dt>Due now</dt>
                <dd>{money(quote.amount_due_today, quote.currency)}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt>New recurring total</dt>
                <dd>
                  {money(quote.new_total, quote.currency)} /{" "}
                  {quote.interval_count > 1 ? `${quote.interval_count} ` : ""}
                  {quote.interval}
                  {quote.interval_count > 1 ? "s" : ""}
                </dd>
              </div>
            </dl>
            <button
              type="button"
              className="w-full rounded-md bg-primary px-3 py-2 text-xs text-primary-foreground"
              onClick={() => void invite(undefined, quote)}
            >
              Add seat and send invite
            </button>
            <button
              type="button"
              className="w-full text-xs text-muted-foreground"
              onClick={() => {
                setQuote(null);
                input.current?.focus();
              }}
            >
              Cancel
            </button>
          </div>
        )}
        {result && (
          <p
            role={result.kind === "sent" ? "status" : "alert"}
            className="flex items-start gap-1.5 break-words text-xs leading-relaxed"
          >
            {result.kind === "sent" && (
              <Check className="mt-0.5 h-3 w-3 shrink-0" />
            )}
            <span className="min-w-0">{result.message}</span>
          </p>
        )}
        <div className="border-t pt-3">
          <button
            type="button"
            onClick={onManage}
            className="flex w-full items-center justify-between text-xs text-muted-foreground hover:text-foreground"
          >
            <span>Manage team on the web</span>
            <ArrowUpRight className="h-3.5 w-3.5" />
          </button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
