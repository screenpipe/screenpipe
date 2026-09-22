// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";

import { useMemo, type ComponentProps } from "react";
import { GTProvider } from "gt-react";

export function OfflineGTProvider(props: ComponentProps<typeof GTProvider> & { locale: string }) {
  // GT's browser store normally reads locale back from document.cookie, which
  // WKWebView cannot persist on tauri://localhost. Supply resolved conditions
  // directly so settings remain authoritative on every desktop platform. A new
  // condition store also updates memoized consumers without remounting drafts.
  const conditions = useMemo(() => ({
    locale: props.locale,
    region: props.region,
    enableI18n: props.enableI18n ?? true,
  }), [props.locale, props.region, props.enableI18n]);
  return <GTProvider {...props} _serverConditions={conditions} />;
}
