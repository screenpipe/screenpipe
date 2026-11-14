// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

export const WORKFLOW_NAME_SELECTOR = 'input[placeholder="Name this workflow"]';
export const STAR_ENTRY_SELECTOR = 'button[aria-label="Starred work sessions"], button[aria-label="Open recording controls"]';

export function unfinishedFocusedSession(session: { phase: string } | null): boolean {
  return session !== null && ["recording", "paused", "summary"].includes(session.phase);
}
