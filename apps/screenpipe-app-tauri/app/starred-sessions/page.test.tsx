// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import Page from "./page";

const mocks = vi.hoisted(() => ({
  resize: vi.fn(),
  move: vi.fn(),
  hide: vi.fn(),
  fetch: vi.fn(),
  visibility: null as null | ((e: { payload: boolean }) => void),
}));
vi.mock("@/lib/utils/tauri", () => ({
  commands: { hideStarredSessions: mocks.hide },
}));
vi.mock("@tauri-apps/api/window", () => ({
  LogicalSize: class { constructor(public width: number, public height: number) {} },
  PhysicalPosition: class { constructor(public x: number, public y: number) {} },
  currentMonitor: async () => ({ workArea: { position: { x: -1920, y: -1080 }, size: { width: 1920, height: 1040 } } }),
  getCurrentWindow: () => ({
    setSize: mocks.resize, setPosition: mocks.move,
    outerPosition: async () => ({ x: -250, y: -160 }),
    outerSize: async () => ({ width: 616, height: 600 }),
  }),
}));
vi.mock("@/lib/api", () => ({ ensureApiReady: async () => {}, localFetch: mocks.fetch }));
vi.mock("@/lib/hooks/use-tauri-event", () => ({
  useTauriEvent: (name: string, callback: typeof mocks.visibility) => {
    if (name === "starred-sessions-visibility") mocks.visibility = callback;
  },
}));
vi.mock("@/lib/chat-utils", () => ({ showChatWithPrefill: vi.fn() }));
vi.mock("@tauri-apps/plugin-opener", () => ({ revealItemInDir: vi.fn() }));
vi.mock("@/lib/hooks/use-managed-policy", () => ({ useManagedPolicy: () => ({ isManagedDeploymentResolved:true,isManagedAuthenticated:true,authenticationState:"authenticated",policy:{recordingAllowed:true,lockedSettings:{}} }) }));
vi.mock("@/lib/hooks/use-settings", () => ({ useSettings: () => ({ isSettingsLoaded:true,settings:{disableAudio:false} }) }));
vi.mock("@tauri-apps/api/event", () => ({ emit: vi.fn(async()=>{}) }));
const fixture = () => ({ id:"fixture",name:"Fixture workflow",phase:"recording",voiceEnabled:false,revision:1,createdAt:Date.now(),lastCaptureAt:Date.now(),captureUntil:Date.now()+15000,intervals:[{start:Date.now(),end:null}],media:null });
beforeEach(() => {
  vi.clearAllMocks();
  mocks.hide.mockResolvedValue({ status: "ok", data: null });
  mocks.fetch.mockResolvedValue({ ok: true, json: async () => fixture() });
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

it("opens the running recording directly and dismisses with Escape", async () => {
  render(<Page />);
  expect(await screen.findByRole("button",{name:"Finish"})).toBeVisible();
  expect(screen.queryByRole("button",{name:"Start"})).toBeNull();
  fireEvent.keyDown(window,{key:"Escape"});
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(mocks.hide).toHaveBeenCalledOnce();
});
it("keeps the same controls mounted while hidden and reopens without a new capture", async () => {
  render(<Page />);
  const name = await screen.findByRole("textbox",{name:"Workflow name"});
  act(() => mocks.visibility!({payload:false}));
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(name).toBeInTheDocument();
  act(() => mocks.visibility!({payload:true}));
  expect(screen.getByRole("textbox",{name:"Workflow name"})).toBe(name);
  expect(mocks.fetch).toHaveBeenCalledOnce();
});
it("keeps load errors and Retry visible without fabricating a recording", async () => {
  mocks.fetch.mockResolvedValue({ok:false,status:503,json:async()=>({error:"Save unavailable"})});
  render(<Page />);
  expect(await screen.findByRole("alert")).toHaveTextContent("Save unavailable");
  expect(screen.queryByRole("button",{name:"Finish"})).toBeNull();
  mocks.fetch.mockResolvedValue({ok:true,json:async()=>fixture()});
  fireEvent.click(screen.getByRole("button",{name:"Retry"}));
  expect(await screen.findByRole("button",{name:"Finish"})).toBeEnabled();
});
it("Escape cancels delete confirmation before it can dismiss the native panel", async () => {
  const saved = {...fixture(),phase:"summary",intervals:[],media:{screenFrames:1,audioSeconds:0,audioChunks:0}};
  mocks.fetch.mockResolvedValue({ok:true,json:async()=>saved});
  render(<Page />);
  fireEvent.click(await screen.findByRole("button",{name:"Delete"}));
  expect(screen.getByText("Delete recording?")).toBeVisible();
  fireEvent.keyDown(screen.getByRole("region",{name:"Focused recording"}),{key:"Escape"});
  expect(screen.getByRole("button",{name:"Save"})).toBeVisible();
  expect(mocks.hide).not.toHaveBeenCalled();
});
it("never dismisses an unsent summary after five idle seconds", async () => {
  mocks.fetch.mockResolvedValue({ok:true,json:async()=>({...fixture(),phase:"summary",intervals:[],media:{screenFrames:0,audioSeconds:0,audioChunks:0}})});
  render(<Page />); await screen.findByRole("button",{name:"Save"});
  vi.useFakeTimers(); await act(async()=>{await vi.advanceTimersByTimeAsync(60000);});
  expect(mocks.hide).not.toHaveBeenCalled();
});
it("retains the controls when native dismissal fails", async () => {
  render(<Page />); await screen.findByRole("button",{name:"Finish"});
  mocks.hide.mockResolvedValueOnce({status:"error",error:"Unavailable"});
  fireEvent.click(screen.getByRole("button",{name:"Close session controls"}));
  expect(await screen.findByRole("alert")).toHaveTextContent("Could not close the panel");
  expect(screen.getByRole("dialog")).toBeVisible();
});
it("fits controls inside a negative-origin monitor work area", async () => {
  let resized!: () => void;
  vi.stubGlobal("ResizeObserver",class { constructor(callback:()=>void){resized=callback;} observe(){} disconnect(){} });
  try {
    const {container}=render(<Page />);
    Object.defineProperty(container.firstElementChild,"scrollHeight",{value:300});
    await act(async()=>{resized();});
    expect(mocks.resize).toHaveBeenCalledWith(expect.objectContaining({width:308,height:300}));
    expect(mocks.move).toHaveBeenCalledWith(expect.objectContaining({x:-616,y:-640}));
  } finally {cleanup();vi.unstubAllGlobals();}
});
