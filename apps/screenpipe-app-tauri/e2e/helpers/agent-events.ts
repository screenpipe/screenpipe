// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

export type AgentEnvelope = {
  source?: string;
  sessionId?: string;
  event?: Record<string, any>;
};

export async function installAgentEventCapture(): Promise<void> {
  const installed = (await browser.executeAsync((done: (value: boolean) => void) => {
    if ((window as any).__e2eAcpAgentEventCaptureInstalled) {
      done(true);
      return;
    }
    (window as any).__e2eAcpAgentEvents = Array.isArray((window as any).__e2eAcpAgentEvents)
      ? (window as any).__e2eAcpAgentEvents
      : [];
    const listen = (window as any).__TAURI__?.event?.listen as
      | ((name: string, cb: (event: { payload?: AgentEnvelope }) => void) => Promise<unknown>)
      | undefined;
    if (!listen) {
      done(false);
      return;
    }
    void listen("agent_event", (event) => {
      (window as any).__e2eAcpAgentEvents.push(event.payload);
    })
      .then(() => {
        (window as any).__e2eAcpAgentEventCaptureInstalled = true;
        done(true);
      })
      .catch(() => done(false));
  })) as boolean;
  expect(installed).toBe(true);
}

export async function capturedEvents(sessionId: string): Promise<AgentEnvelope[]> {
  return (await browser.execute((id: string) => {
    const events = Array.isArray((window as any).__e2eAcpAgentEvents)
      ? (window as any).__e2eAcpAgentEvents
      : [];
    return events.filter((event: AgentEnvelope) => event?.sessionId === id);
  }, sessionId)) as AgentEnvelope[];
}

