// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";

import { useGT } from "gt-react";
import { useSettings } from "@/lib/hooks/use-settings";
import { bundledLocales, localeName, useLocalizationEnabled } from "@/lib/i18n/provider";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useToast } from "@/components/ui/use-toast";

export function LanguageSelector() {
  const { settings, updateSettings } = useSettings();
  const gt = useGT();
  const { toast } = useToast();
  const enabled = useLocalizationEnabled();
  if (!enabled) return null;
  const changeLocale = async (uiLocale: string) => {
    try { await updateSettings({ uiLocale }); }
    catch {
      toast({ title: gt("Couldn't change language to {language}", { language: uiLocale === "system" ? gt("System default") : localeName(uiLocale) }), description: gt("Please try again"), variant: "destructive" });
    }
  };
  return <div className="flex flex-wrap items-center justify-between gap-3" data-testid="language-selector">
    <Label htmlFor="ui-language">Language</Label>
    <Select value={typeof settings.uiLocale === "string" ? settings.uiLocale : "system"} onValueChange={(locale) => void changeLocale(locale)}>
      <SelectTrigger id="ui-language" aria-label={gt("Language")} className="w-auto min-w-40 max-w-full"><SelectValue /></SelectTrigger>
      <SelectContent>
        <SelectItem value="system">System default</SelectItem>
        {bundledLocales.map((locale) => <SelectItem key={locale} value={locale}>{localeName(locale)}</SelectItem>)}
      </SelectContent>
    </Select>
  </div>;
}
