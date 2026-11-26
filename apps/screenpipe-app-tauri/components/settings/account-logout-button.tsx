// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";

import { useGT } from "gt-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/use-toast";
import { useSettings } from "@/lib/hooks/use-settings";
import { commands } from "@/lib/utils/tauri";

export function AccountLogoutButton() {
  const ui = useGT();
  const { settings, updateSettings } = useSettings();

  if (!settings.user?.token) return null;

  return (
    <Button
      variant="outline"
      size="sm"
      data-testid="account-logout-button"
      onClick={async () => {
        await updateSettings({ user: null as any });
        try {
          await commands.setCloudToken(null);
        } catch (error) {
          console.warn("failed to clear cloud token on logout:", error);
        }
        // Restart Pi without the signed-out account's token.
        try {
          await commands.piUpdateConfig(null, null);
        } catch {}
        toast({ title: ui("Logged out") });
      }}
    >
      {ui("Logout")}
    </Button>
  );
}
