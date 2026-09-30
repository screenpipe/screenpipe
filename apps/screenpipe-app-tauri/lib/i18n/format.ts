// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

/** Presentation only: timestamps and stored values remain unchanged. */
export function formatUiRelativeTime(value: Date | number | string, locale: string, now = Date.now()) {
  const delta = (new Date(value).getTime() - now) / 1000;
  if (!Number.isFinite(delta)) return "";
  const unit: Intl.RelativeTimeFormatUnit = Math.abs(delta) < 60 ? "second" : Math.abs(delta) < 3600 ? "minute" : Math.abs(delta) < 86400 ? "hour" : "day";
  const seconds = {second: 1, minute: 60, hour: 3600, day: 86400}[unit];
  return new Intl.RelativeTimeFormat(locale, {numeric: "auto", style: "short"}).format(Math.round(delta / seconds), unit);
}

export function formatUiCompactAge(timestamp: number | undefined, now: number, locale: string): string | null {
  if (!timestamp || !Number.isFinite(timestamp)) return null;
  const seconds = Math.max(0, now - timestamp) / 1000;
  if (seconds < 60) return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(0, "second");
  const units: [string, number][] = [["year", 31536000], ["month", 2592000], ["week", 604800], ["day", 86400], ["hour", 3600], ["minute", 60]];
  const [unit, size] = units.find(([, size]) => seconds >= size)!;
  return new Intl.NumberFormat(locale, { style: "unit", unit, unitDisplay: "short" }).format(Math.floor(seconds / size));
}
