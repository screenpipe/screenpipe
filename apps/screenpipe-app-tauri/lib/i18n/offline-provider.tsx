// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";

import { useMemo, type ComponentProps } from "react";
import { GTProvider } from "gt-react";

export function OfflineGTProvider(props: ComponentProps<typeof GTProvider>) {
  // GT 11.4's browser condition store retains its identity on locale changes.
  // Refresh the context snapshot so memoized useGT/useLocale consumers rerender,
  // without keying/remounting their components or losing drafts and sessions.
  const translations = useMemo(() => ({ ...props.translations }), [props.translations, props.locale]);
  return <GTProvider {...props} translations={translations} />;
}
