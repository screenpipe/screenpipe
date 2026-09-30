// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ComponentProps, type ReactNode } from "react";
import { GTProvider, initializeGT, getLocaleProperties } from "gt-react";
import { useSettings } from "@/lib/hooks/use-settings";
import { locale as operatingSystemLocale } from "@tauri-apps/plugin-os";
import { resolveLocale } from "./locale";
import bundled from "@/lib/i18n/generated.json";
import { OfflineGTProvider } from "./offline-provider";

type Snapshot = {
  mode: string; revision: string; defaultLocale: string; locales: string[];
  translations: ComponentProps<typeof GTProvider>["translations"];
  coverage: Record<string, unknown>; fallbacks: Record<string, Record<string, string>>; causes: string[];
};
export const localizationSnapshot = bundled as Snapshot;
const { defaultLocale, locales, translations } = localizationSnapshot;
export const bundledLocales = [defaultLocale, ...locales];

// A local loader is mandatory even with a supplied provider snapshot: GT may
// ask its cache for a missing locale. Never configure runtime credentials/CDN.
initializeGT({ defaultLocale, locales, loadTranslations: async (locale) => translations[locale] ?? {}, runtimeUrl: null, _disableDevHotReload: true });

const LocaleContext = createContext(defaultLocale);
export function useUiLocale() { return useContext(LocaleContext); }
const LocalizationEnabledContext = createContext(false);
export function useLocalizationEnabled() { return useContext(LocalizationEnabledContext); }

export function LocalizationProvider({ children }: { children: ReactNode }) {
  const { settings } = useSettings();
  const [system, setSystem] = useState<readonly string[]>([]);
  useEffect(() => {
    let active = true;
    const update = () => {
      setSystem([...navigator.languages]);
      void operatingSystemLocale().then((native) => {
        if (active && native) setSystem([native, ...navigator.languages]);
      }).catch(() => { /* Browser preview uses navigator.languages. */ });
    };
    update();
    window.addEventListener("languagechange", update);
    return () => { active = false; window.removeEventListener("languagechange", update); };
  }, []);
  const configured = typeof settings.uiLocale === "string" ? settings.uiLocale : "system";
  const rolloutEnabled = settings.uiLocalizationEnabled === true;
  const enabled = rolloutEnabled && locales.length > 0;
  const locale = enabled ? resolveLocale(configured, system, bundledLocales, defaultLocale) : defaultLocale;
  useEffect(() => {
    document.documentElement.lang = locale;
    try {
      localStorage.setItem("screenpipe-ui-localization-enabled", String(enabled));
      localStorage.setItem("screenpipe-ui-locale", locale);
    } catch { /* Optional crash-screen cache. */ }
    const info = new Intl.Locale(locale) as Intl.Locale & { textInfo?: { direction: string }; getTextInfo?: () => { direction: string } };
    document.documentElement.dir = info.getTextInfo?.().direction ?? info.textInfo?.direction ?? "ltr";
    // This is an allow-listed diagnostic summary: no message text or interpolation
    // values. The bridge includes it in the normal collected support report.
    console.info("[localization]", JSON.stringify({ configured, resolved: locale, rolloutEnabled, revision: localizationSnapshot.revision, coverage: localizationSnapshot.coverage[locale], causes: localizationSnapshot.causes, fallbackCount: Object.keys(localizationSnapshot.fallbacks[locale] ?? {}).length }));
  }, [configured, locale, rolloutEnabled, enabled]);
  return <LocalizationEnabledContext.Provider value={enabled}><LocaleContext.Provider value={locale}><OfflineGTProvider locale={locale} translations={translations}>{children}</OfflineGTProvider></LocaleContext.Provider></LocalizationEnabledContext.Provider>;
}

export function localeName(locale: string) {
  const name = getLocaleProperties(locale).nativeName;
  return name.charAt(0).toLocaleUpperCase(locale) + name.slice(1);
}

export function useLocaleFormatters() {
  const locale = useUiLocale();
  return useMemo(() => ({
    number: (value: number, options?: Intl.NumberFormatOptions) => new Intl.NumberFormat(locale, options).format(value),
    date: (value: Date | number, options?: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(locale, options).format(value),
    plural: (value: number) => new Intl.PluralRules(locale).select(value),
  }), [locale]);
}


// Next's root error boundary is outside SettingsProvider. It can still show
// bundled recovery controls in the last resolved language without IPC/network.
export function EmergencyLocalizationProvider({children}: {children: ReactNode}) {
  const [locale] = useState(() => {
    if (typeof window === "undefined") return defaultLocale;
    let stored: string | null = null;
    try {
      if (localStorage.getItem("screenpipe-ui-localization-enabled") !== "true") return defaultLocale;
      stored = localStorage.getItem("screenpipe-ui-locale");
    } catch { return defaultLocale; }
    return resolveLocale(stored ?? "system", navigator.languages, bundledLocales, defaultLocale);
  });
  return <LocaleContext.Provider value={locale}><OfflineGTProvider locale={locale} translations={translations}>{children}</OfflineGTProvider></LocaleContext.Provider>;
}
