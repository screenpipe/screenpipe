// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { readFileSync, writeFileSync } from 'node:fs';
try {
  const sdk = JSON.parse(readFileSync('apps/screenpipe-app-tauri/node_modules/posthog-js/package.json', 'utf8'));
  if (sdk.version !== '1.359.1') throw new Error('expected posthog-js@1.359.1, found ' + sdk.version);
} catch (error) {
  console.error('Required locked SDK runtime unavailable: ' + error.message);
  process.exit(127);
}
const file = 'apps/screenpipe-app-tauri/app/onboarding/page.test.tsx';
const source = readFileSync(file, 'utf8');
const start = source.indexOf('    it("settles cold authenticated flags');
const end = source.indexOf('\n  });\n\n});\n\ndescribe("timeline slide sequencing"', start);
if (start < 0 || end < 0) throw new Error('Pinned SDK grader fixture boundary missing');
writeFileSync(file, source.slice(0, start).replace('describe("real PostHog assignment transport"', 'describe("eval SDK assignment outcomes"') + `    function autoRespond(variant: string | false | undefined, delay = 2_000) {
      vi.mocked(mocks.sdk!._send_request).mockImplementation((request) => {
        if (!request.url.includes("/flags/")) return;
        const pending = request as unknown as FlagRequest;
        requests.push(pending);
        setTimeout(() => pending.callback?.({ statusCode: 200, json: {
          featureFlags: variant === undefined ? {} : { "first-summary-card-trial-v1": variant },
        } }), delay);
      });
    }
    const pinned = () => window.sessionStorage.getItem(TRIAL_ACTIVATION_ASSIGNMENT_SESSION_KEY);
    const pending = () => screen.queryByTestId("trial-activation-assignment-pending");
    async function finishQueued(variant: string) {
      const handled = new Set<FlagRequest>();
      for (let cycle = 0; cycle < 8; cycle++) {
        await act(async () => vi.advanceTimersByTimeAsync(10));
        for (const request of [...requests]) {
          if (handled.has(request) || request.data.distinct_id !== mocks.settings.user!.clerk_id) continue;
          handled.add(request);
          await act(async () => request.callback?.({ statusCode: 200,
            json: { featureFlags: { "first-summary-card-trial-v1": variant } } }));
        }
      }
    }
    it.each(["summary_first", "control", false, undefined])("resolves cold remote %s within the existing deadline", async variant => {
      autoRespond(variant);
      render(<OnboardingPage />);
      await act(async () => vi.advanceTimersByTimeAsync(4_500));
      expect(pending()).not.toBeInTheDocument();
      expect(screen.getByText("engine")).toBeInTheDocument();
      expect(pinned()).toBe(variant === "summary_first" ? variant : "control");
      await act(async () => vi.advanceTimersByTimeAsync(500));
      expect(mocks.capture).not.toHaveBeenCalledWith("trial_activation_assignment_failed", expect.anything(), expect.anything());
      expect(requests.every(request => request.data.distinct_id === "clerk-1")).toBe(true);
    });
    it("ignores cached and old-identity values until fresh identity evidence arrives", async () => {
      mocks.sdk!.identify("machine-1");
      await act(async () => vi.advanceTimersByTimeAsync(10));
      await respond(0, "summary_first");
      mocks.sdk!.reloadFeatureFlags();
      await act(async () => vi.advanceTimersByTimeAsync(10));
      const older = requests.findLast(request => request.data.distinct_id === "machine-1")!;
      mocks.sdk!.identify("clerk-1");
      render(<OnboardingPage />);
      expect(pending()).toBeInTheDocument();
      expect(pinned()).toBeNull();
      await act(async () => older.callback?.({ statusCode: 200, json: {
        featureFlags: { "first-summary-card-trial-v1": "summary_first" },
      } }));
      expect(pending()).toBeInTheDocument();
      expect(pinned()).toBeNull();
      act(() => mocks.sdk!.featureFlags.updateFlags({ "first-summary-card-trial-v1": "summary_first" }));
      expect(pinned()).toBeNull();
      await finishQueued("control");
      expect(pinned()).toBe("control");
      expect(pending()).not.toBeInTheDocument();
    });
    it("does not pin an old account response after the authenticated account changes", async () => {
      const { rerender } = render(<OnboardingPage />);
      await act(async () => vi.advanceTimersByTimeAsync(10));
      const older = requests[0];
      mocks.settings.user!.clerk_id = "clerk-2";
      mocks.sdk!.identify("clerk-2");
      rerender(<OnboardingPage />);
      await act(async () => older.callback?.({ statusCode: 200, json: {
        featureFlags: { "first-summary-card-trial-v1": "summary_first" },
      } }));
      expect(pinned()).toBeNull();
      await finishQueued("control");
      expect(pinned()).toBe("control");
    });
    it.each(["control", "summary_first"])("preserves pinned %s without remote reassignment", async variant => {
      window.sessionStorage.setItem(TRIAL_ACTIVATION_ASSIGNMENT_SESSION_KEY, variant);
      autoRespond(variant === "control" ? "summary_first" : "control");
      render(<OnboardingPage />);
      await act(async () => vi.advanceTimersByTimeAsync(5_000));
      expect(screen.getByText("engine")).toBeInTheDocument();
      expect(pinned()).toBe(variant);
      expect(requests).toHaveLength(0);
    });
    it("retains the five-second fallback and ignores late treatment", async () => {
      autoRespond("summary_first", 6_000);
      render(<OnboardingPage />);
      await act(async () => vi.advanceTimersByTimeAsync(4_999));
      expect(pending()).toBeInTheDocument();
      await act(async () => vi.advanceTimersByTimeAsync(1));
      expect(screen.getByText("engine")).toBeInTheDocument();
      expect(pinned()).toBe("control");
      await act(async () => vi.advanceTimersByTimeAsync(10_000));
      expect(pinned()).toBe("control");
    });
    it("preserves opt-out without identifying or enrolling the machine assignment", async () => {
      mocks.sdk!.identify("machine-1");
      mocks.sdk!.opt_out_capturing();
      const identify = vi.spyOn(mocks.sdk!, "identify");
      autoRespond("summary_first", 10);
      render(<OnboardingPage />);
      await act(async () => vi.advanceTimersByTimeAsync(5_000));
      expect(identify).not.toHaveBeenCalled();
      expect(mocks.sdk!.has_opted_out_capturing()).toBe(true);
      expect(pinned()).toBe("control");
      expect(screen.getByText("engine")).toBeInTheDocument();
    });
    it("does not pin an assignment or report a failure after unmount", async () => {
      autoRespond("summary_first");
      const { unmount } = render(<OnboardingPage />);
      await act(async () => vi.advanceTimersByTimeAsync(100));
      unmount();
      await act(async () => vi.advanceTimersByTimeAsync(10_000));
      expect(pinned()).toBeNull();
      expect(mocks.capture).not.toHaveBeenCalledWith("trial_activation_assignment_failed", expect.anything(), expect.anything());
    });
` + source.slice(end));

const setup = 'apps/screenpipe-app-tauri/vitest.setup.ts';
writeFileSync(setup, readFileSync(setup, 'utf8') + '\n// Offline synthetic evaluation only.\nglobalThis.fetch = async () => { throw new Error("live fetch forbidden in evaluation"); };\nXMLHttpRequest.prototype.open = function () { throw new Error("live XHR forbidden in evaluation"); };\n');
