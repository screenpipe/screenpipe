// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import React, { useMemo, useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WorkflowGuide } from "../../../../packages/workflows-ui/src/workflow-guide";
import { WorkflowAssistant } from "../../../../packages/workflows-ui/src/workflow-assistant";
import { PageAssistantContext, type PageAssistant } from "../../../../packages/workflows-ui/src/page-assistant";
import { fixtureWorkflowAnalysis } from "../../../../packages/workflows-ui/src/fixture-platform";
import type { WorkflowGuide as Guide } from "../../../../packages/workflows-ui/src/guide";
import type { WorkflowsPlatform } from "../../../../packages/workflows-ui/src/platform";
import type { AssistantState, WorkflowsAssistantPlatform } from "../../../../packages/workflows-ui/src/assistant";

const workflow = structuredClone(fixtureWorkflowAnalysis.analysis.workflows[0]);
workflow.stages[0].screenshot = { frameId: 5, timestamp: "2026-09-01T10:00:00Z", app: "Docs", dataUrl: "data:image/png;base64,AA==" };
const guide: Guide = { version: 1, workflowKey: workflow.id || workflow.title, sourceRevision: workflow.revision ?? 0, title: "Review a brief", summary: "Review sources.", prerequisites: [], steps: [{ title: "Read", instruction: "Read each source.", expectedResult: "Every claim has a source.", sourceStage: 0, includeImage: true }], exceptions: [], completion: [], questions: [] };
const result = { url: "asset://video.mp4", path: "/video.mp4", captionsPath: "/captions.vtt" };
afterEach(cleanup);
function setup() {
  const edit = vi.fn(async (draft, _request, _history, _signal, progress) => {
    progress("Reading the video project");
    return { draft, render: true, changed: false, message: "" };
  });
  const generate = vi.fn(async (_scenes, _signal, progress) => { progress("Rendering the video"); return { ...result, path: "/second-video.mp4" }; });
  const release = vi.fn(async () => {});
  const guides = { load: async () => guide, save: vi.fn(async () => {}), video: { edit, generate, release, export: vi.fn() } } as unknown as NonNullable<WorkflowsPlatform["guides"]>;
  const storage = { load: async () => null, save: vi.fn(async (_snapshot: AssistantState) => {}) };
  function App() {
    const [page, setPage] = useState<PageAssistant | null>(null);
    const assistant = useMemo(() => ({ ...storage, ask: request => page!.ask(request) }) as WorkflowsAssistantPlatform, [page]);
    return <PageAssistantContext.Provider value={setPage}>
      <WorkflowGuide workflow={workflow} platform={guides} close={() => {}} />
      <WorkflowAssistant platform={assistant} promptRequest={page?.promptRequest} onBusyChange={page?.onBusyChange} context={page?.context ?? { key: "home", title: "Home" }} onDockChange={() => {}} />
    </PageAssistantContext.Provider>;
  }
  const view = render(<App />);
  return { edit, generate, release, guides, storage, view };
}
async function openVideo() {
  fireEvent.click(await screen.findByRole("button", { name: "Video SOP" }));
  fireEvent.click(screen.getByRole("button", { name: "Create video", exact: true }));
}
it("starts from the page, streams in chat, keeps the finished preview and chat visible, and supports a second creation", async () => {
  const s = setup();
  let finish!: () => void;
  s.generate.mockImplementationOnce(async (_scenes, _signal, progress) => {
    progress("Rendering 1 of 3");
    await new Promise<void>(resolve => { finish = resolve; });
    return result;
  });
  await openVideo();
  const chat = await screen.findByRole("region", { name: "Screenpipe assistant" });
  await within(chat).findByText("Rendering 1 of 3");
  expect(screen.getAllByText("Rendering 1 of 3")).toHaveLength(1);
  expect(screen.getByRole("region", { name: "Video SOP" })).toBeVisible();
  expect(within(chat).getByRole("button", { name: "Stop answer" })).toBeVisible();
  expect(screen.queryByRole("button", { name: "Stop", exact: true })).toBeNull();
  expect(s.edit).toHaveBeenCalledTimes(1);
  expect(s.generate).toHaveBeenCalledTimes(1);
  fireEvent.click(within(chat).getByRole("button", { name: "Minimize chat" }));
  expect(screen.queryByRole("region", { name: "Screenpipe assistant" })).toBeNull();
  expect(screen.getByRole("region", { name: "Video SOP" })).toBeVisible();
  expect(s.generate.mock.calls[0][1].aborted).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Ask Screenpipe" }));
  await act(async () => finish());
  await screen.findByLabelText("Narrated SOP preview");
  const reopened = await screen.findByRole("region", { name: "Screenpipe assistant" });
  await within(reopened).findByText(/Your video is ready on the page/);
  expect(reopened).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Create new video" }));
  await waitFor(() => expect(s.generate).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Stop answer" })).toBeNull());
  expect(s.edit.mock.calls[1][2].some(message => message.role === "user")).toBe(true);
});
it("stops from chat and discards a late result without displaying it", async () => {
  const s = setup();
  let finish!: () => void;
  let signal!: AbortSignal;
  s.generate.mockImplementationOnce(async (_scenes, nextSignal, progress) => {
    signal = nextSignal; progress("Rendering the video");
    await new Promise<void>(resolve => { finish = resolve; }); return result;
  });
  await openVideo();
  await waitFor(() => expect(s.generate).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByRole("button", { name: "Stop answer" }));
  expect(signal.aborted).toBe(true);
  await act(async () => finish());
  expect(s.release).toHaveBeenCalledWith(result);
  expect(screen.queryByLabelText("Narrated SOP preview")).toBeNull();
  expect(await screen.findByRole("button", { name: "Create video", exact: true })).toBeEnabled();
});
it("reports speech failure in chat and retries without duplicating the user request", async () => {
  const s = setup(); s.generate.mockRejectedValueOnce(new Error("Speech unavailable"));
  await openVideo();
  const chat = await screen.findByRole("region", { name: "Screenpipe assistant" });
  await within(chat).findByText("Speech unavailable");
  fireEvent.click(within(chat).getByRole("button", { name: "Try again", exact: true }));
  await screen.findByLabelText("Narrated SOP preview");
  expect(within(chat).getAllByLabelText("Your question")).toHaveLength(1);
  expect(s.generate).toHaveBeenCalledTimes(2);
});

it("releases the page button when stopped before the persisted turn can start the agent", async () => {
  const s = setup();
  await screen.findByRole("button", { name: "Video SOP" });
  let finish!: () => void;
  let blocked = false;
  s.storage.save.mockImplementation(async snapshot => {
    if (!blocked && snapshot.conversations.some(conversation => conversation.messages.some(message => message.role === "user" && message.text.startsWith("Create a narrated video")))) {
      blocked = true;
      await new Promise<void>(resolve => { finish = resolve; });
    }
  });
  await openVideo();
  await screen.findByRole("button", { name: "Stop answer" });
  fireEvent.click(screen.getByRole("button", { name: "Stop answer" }));
  await act(async () => finish());
  await waitFor(() => expect(screen.getByRole("button", { name: "Create video", exact: true })).toBeEnabled());
  expect(s.generate).not.toHaveBeenCalled();
});

it("shows real tool progress and displays the agent artifact without a page render", async () => {
 const s=setup();let finish!:()=>void;
 s.edit.mockImplementationOnce(async (draft,_request,_history,_signal,progress:any) => {
  progress({text:"I’ll create the video from your saved script.",activity:"working",toolCalls:[{id:"read",name:"read_video_sop",status:"complete"},{id:"render",name:"render_video_sop",status:"running",detail:"Narrating 4 of 7"}]});
  await new Promise<void>(resolve=>{finish=resolve;});
  progress({text:"",activity:"working",toolCalls:[{id:"read",name:"read_video_sop",status:"complete"},{id:"render",name:"render_video_sop",status:"complete",detail:"Video and captions ready"}]});
  return {draft,changed:false,render:false,result,message:"Your video is ready on the page."};
 });
 await openVideo();const chat=await screen.findByRole("region",{name:"Screenpipe assistant"});
 await within(chat).findByText("Narrating 4 of 7", {selector:"small"});expect(within(chat).getByText("render video sop")).toBeVisible();
 await act(async()=>finish());await screen.findByLabelText("Narrated SOP preview");
 expect(s.generate).not.toHaveBeenCalled();expect(within(chat).getByText("read video sop")).toBeVisible();
});
