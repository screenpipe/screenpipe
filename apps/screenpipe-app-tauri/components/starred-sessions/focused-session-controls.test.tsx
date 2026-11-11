// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FocusedSessionControls } from "./focused-session-controls";
const mocks = vi.hoisted(() => ({ recorder: {} as any, hook: vi.fn(), dismiss: vi.fn() }));
vi.mock("./use-focused-recording", () => ({ useFocusedRecording: (...args: unknown[]) => { mocks.hook(...args); return mocks.recorder; } }));
vi.mock("@/lib/hooks/use-managed-policy", () => ({ useManagedPolicy: () => ({ isManagedDeploymentResolved:true,isManagedAuthenticated:true,policy:{recordingAllowed:true,lockedSettings:{}} }) }));
vi.mock("@/lib/hooks/use-settings", () => ({ useSettings: () => ({ isSettingsLoaded:true,settings:{disableAudio:false} }) }));
beforeEach(() => {
 vi.clearAllMocks();
 mocks.recorder = { session:{id:"fixture",phase:"summary",media:{screenFrames:3,audioSeconds:2,audioChunks:1}}, name:"Fixture workflow",hot:false,error:undefined,busy:false,seconds:12,
 setName:vi.fn(),act:vi.fn(async()=>{}),retry:vi.fn(),toggleVoice:vi.fn(),newWorkflow:vi.fn() };
});
afterEach(() => { cleanup(); vi.useRealTimers(); });
it("requires explicit deletion and Keep recording returns to the frozen summary", () => {
 render(<FocusedSessionControls onDismiss={mocks.dismiss} />);
 fireEvent.click(screen.getByRole("button",{name:"Delete"}));
 expect(screen.getByText("Delete recording?")).toBeVisible();
 expect(mocks.recorder.act).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole("button",{name:"Keep recording"}));
 expect(screen.getByRole("button",{name:"Submit"})).toBeVisible();
 expect(mocks.recorder.act).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole("button",{name:"Delete"}));
 fireEvent.click(screen.getByRole("button",{name:"Delete"}));
 expect(mocks.recorder.act).toHaveBeenCalledWith("delete");
});
it("never dismisses an unsent summary on an inactivity timer", () => {
 vi.useFakeTimers(); render(<FocusedSessionControls onDismiss={mocks.dismiss} />);
 act(() => { vi.advanceTimersByTime(60000); });
 expect(mocks.dismiss).not.toHaveBeenCalled();
});
it("dismisses only submitted work after fifteen seconds, protecting focused controls", () => {
 vi.useFakeTimers(); mocks.recorder.session.phase="submitted";
 render(<FocusedSessionControls onDismiss={mocks.dismiss} />);
 fireEvent.focus(screen.getByRole("button",{name:"New workflow"}));
 act(() => { screen.getByRole("button",{name:"New workflow"}).focus(); });
 act(() => { vi.advanceTimersByTime(15000); });
 expect(mocks.dismiss).not.toHaveBeenCalled();
 act(() => { screen.getByRole("button",{name:"New workflow"}).blur(); });
 fireEvent.blur(screen.getByRole("button",{name:"New workflow"}));
 act(() => { vi.advanceTimersByTime(15000); });
 expect(mocks.dismiss).toHaveBeenCalledOnce();
});
