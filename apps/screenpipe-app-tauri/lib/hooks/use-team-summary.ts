// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

import { useEffect, useState } from "react";
import { screenpipeWebUrl } from "@/lib/web-url";

export type TeamEntry = {
  label: string;
  href: string;
  kind: "team" | "no-team" | "signed-out" | "unavailable" | "enterprise";
  teamId?: string;
  canInvite?: boolean;
};
type Summary = { id: string; name: string; plan?: string } | null;
const teamPage = screenpipeWebUrl("/team-dashboard", "https://screenpipe.com");

/** Passive identity lookup. Never loads configs, creates a team, or mints invitations. */
export function useTeamSummary({
  token,
  enabled,
  enterprise,
  orgName,
}: {
  token?: string | null;
  enabled: boolean;
  enterprise: boolean;
  orgName?: string | null;
}): TeamEntry | undefined {
  const [result, setResult] = useState<{
    token: string;
    team: Summary;
    role?: string;
  } | null>(null);
  useEffect(() => {
    if (!enabled || enterprise || !token) return;
    let disposed = false;
    let controller: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      controller?.abort();
      clearTimeout(timer);
      const request = new AbortController();
      controller = request;
      timer = setTimeout(() => request.abort(), 10000);
      try {
        const response = await fetch(
          screenpipeWebUrl("/api/team", "https://screenpipe.com"),
          {
            headers: { Authorization: `Bearer ${token}` },
            signal: request.signal,
          },
        );
        if (!response.ok) throw new Error("Team unavailable");
        const data = await response.json();
        if (
          data.team !== null &&
          (!data.team ||
            typeof data.team.id !== "string" ||
            !data.team.id ||
            typeof data.team.name !== "string" ||
            !data.team.name.trim())
        )
          throw new Error("Invalid team identity");
        if (!disposed && controller === request && !request.signal.aborted)
          setResult({ token, team: data.team, role: data.role });
      } catch {
        // Unknown membership must not look like a confirmed absence of a team.
        if (!disposed && controller === request) setResult(null);
      } finally {
        if (controller === request) clearTimeout(timer);
      }
    };
    void refresh();
    // A name edited on the web is refreshed when the desktop regains focus.
    const onFocus = () => {
      void refresh();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      disposed = true;
      controller?.abort();
      clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [token, enabled, enterprise]);

  if (!enabled) return undefined;
  if (enterprise)
    return {
      label: orgName?.trim() || "Your organization",
      kind: "enterprise",
      href: screenpipeWebUrl(
        "/account/workspace?tab=team&view=members",
        "https://screenpipe.com",
      ),
    };
  if (!token)
    return { label: "Invite your team", href: teamPage, kind: "signed-out" };
  if (!result || result.token !== token)
    return { label: "Team", href: teamPage, kind: "unavailable" };
  return result.team
    ? {
        label: result.team.name,
        kind: "team",
        teamId: result.team.id,
        canInvite: result.role === "admin" && result.team.plan === "team",
        href: `${teamPage}?team_id=${encodeURIComponent(result.team.id)}`,
      }
    : { label: "Invite your team", href: teamPage, kind: "no-team" };
}
