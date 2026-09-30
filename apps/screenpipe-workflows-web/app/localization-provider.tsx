// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";

import { GTProvider, initializeGT } from "gt-react";
import type { ReactNode } from "react";

// The shared desktop UI uses English-source GT calls. This host continues to
// render English offline; its build does not generate or request translations.
initializeGT({defaultLocale: "en", locales: [], loadTranslations: async () => ({}), runtimeUrl: null, _disableDevHotReload: true});

export function LocalizationProvider({children}: {children: ReactNode}) {
  return <GTProvider locale="en" translations={{}}>{children}</GTProvider>;
}
