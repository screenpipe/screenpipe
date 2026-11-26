// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { useEffect, useState } from "react";
import { useGT } from "gt-react";
import { Button } from "@/components/ui/button";
import { commands } from "@/lib/utils/tauri";

export function SwitchToPersonalAccount() {
  const ui = useGT();
  const [available, setAvailable] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [error, setError] = useState(false);

  useEffect(() => {
    let mounted = true;
    async function check() {
      try {
        const allowed = await commands.canSwitchToPersonalAccount();
        if (mounted) setAvailable(allowed);
      } catch {
        if (mounted) setAvailable(false);
      }
    }
    void check();
    window.addEventListener("focus", check);
    return () => {
      mounted = false;
      window.removeEventListener("focus", check);
    };
  }, []);

  if (!available) return null;
  if (!confirming) return (
    <Button variant="outline" size="sm" onClick={() => setConfirming(true)}>
      {ui("Switch to personal account")}
    </Button>
  );

  async function switchAccount() {
    setSwitching(true);
    setError(false);
    try {
      const result = await commands.switchToPersonalAccount();
      if (result.status === "error") throw new Error();
    } catch {
      setError(true);
      setSwitching(false);
    }
  }

  return (
    <div className="space-y-3">
      <p className="text-sm">
        {ui("Screenpipe will sign you out, stop workspace uploads, and restart. Sign in with your personal account. Recordings already on this computer stay here.")}
      </p>
      <div className="flex gap-2">
        <Button size="sm" disabled={switching} onClick={switchAccount}>
          {switching ? ui("Restarting…") : ui("Sign out and restart")}
        </Button>
        <Button size="sm" variant="outline" disabled={switching} onClick={() => { setConfirming(false); setError(false); }}>
          {ui("Cancel")}
        </Button>
      </div>
      {error && <p role="alert">{ui("Couldn’t switch accounts. Reopen Account settings and try again.")}</p>}
    </div>
  );
}
