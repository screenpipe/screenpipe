// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { GuideVideoPanel } from "../../../../packages/workflows-ui/src/guide-video-panel";
import { guideVideoScenes, guideVideoDraft, reconnectGuideSources, videoScreenshotGaps, type GuideVideoPlatform } from "../../../../packages/workflows-ui/src/guide-video";
import { parseGuide, type WorkflowGuide } from "../../../../packages/workflows-ui/src/guide";
import { fixtureWorkflowAnalysis } from "../../../../packages/workflows-ui/src/fixture-platform";

const workflow = structuredClone(fixtureWorkflowAnalysis.analysis.workflows[0]);
workflow.id = "example"; workflow.revision = 2;
workflow.stages[0].screenshot = { frameId: 5, timestamp: "2026-09-01T10:00:00Z", app: "Docs", visualVerified: true, matchDistanceSeconds: 0, dataUrl: "" };
const guide: WorkflowGuide = { version: 1, workflowKey: "example", sourceRevision: 2, title: "Review a brief", summary: "Prepare a sourced brief.",
  prerequisites: ["Collect the source documents."], steps: [{ title: "Review sources", instruction: "Check each claim.", expectedResult: "Each claim has a source.", sourceStage: 0, includeImage: true }],
  exceptions: ["Flag conflicting claims."], completion: ["The reviewer has approved the brief."], questions: ["Who approves the brief?"] };
const result = { url: "asset://example/video.mp4", path: "/example/video.mp4", captionsPath: "/example/captions.vtt" };
function platform(): GuideVideoPlatform { return { generate: vi.fn().mockResolvedValue(result), release: vi.fn().mockResolvedValue(undefined), export: vi.fn().mockResolvedValue(true) }; }
afterEach(cleanup);
describe("video SOP plans", () => {
  it("starts new videos with procedural steps and leaves review notes in the SOP", () => {
    const scenes = guideVideoScenes(guide, workflow);
    expect(scenes).toHaveLength(1);
    expect(scenes[0]).toMatchObject({ image: null, imageFrameId: 5, narration: "Check each claim.\nExpected result: Each claim has a source." });
    for (const text of [...guide.prerequisites, ...guide.exceptions, ...guide.completion, ...guide.questions]) expect(scenes.some(s => s.narration.includes(text))).toBe(false);
    expect(guide.prerequisites).toEqual(["Collect the source documents."]);
    expect(guide.steps[0].expectedResult).toBe("Each claim has a source.");
  });
  it("uses attached captures without an approval flag, but rejects stale or missing selections", () => {
    const unreviewed = structuredClone(workflow);
    unreviewed.stages[0].screenshot!.visualVerified = false;
    expect(guideVideoScenes(guide, unreviewed)[0].imageFrameId).toBe(5);
    const reviewed = structuredClone(guide);
    reviewed.steps[0].imageReview = { frameId: 5, timestamp: "2026-09-01T10:00:00Z" };
    expect(guideVideoScenes(reviewed, unreviewed)[0].imageFrameId).toBe(5);
    reviewed.steps[0].imageReview.timestamp = "2026-09-02T10:00:00Z";
    expect(guideVideoScenes(reviewed, unreviewed)[0].imageFrameId).toBeUndefined();
    expect(() => guideVideoScenes({ ...guide, sourceRevision: 1 }, workflow)).toThrow(/screenshot links/);
  });
  it("supports explicit text-only export and rejects oversized plans without truncating", () => {
    expect(guideVideoScenes(guide, workflow, false).every(s => !s.image && !s.imageFrameId)).toBe(true);
    expect(() => guideVideoScenes({ ...guide, summary: "a".repeat(18001) }, workflow)).toThrow(/too long/);
    const unicode = { ...guide, steps: [{ ...guide.steps[0], instruction: "界😀".repeat(200) }] };
    expect(guideVideoScenes(unicode, workflow)[0].narration).toContain(unicode.steps[0].instruction);
    const edited = structuredClone(guide);
    edited.steps[0].narration = "Outdated narration from an earlier version";
    expect(guideVideoScenes(edited, workflow)[0].narration).toContain(edited.steps[0].instruction);
    expect(guideVideoScenes(edited, workflow)[0].narration).not.toContain("Outdated");
    expect(() => guideVideoScenes({ ...guide, workflowKey: "another" }, workflow)).toThrow(/this workflow/);
    edited.steps[0].instruction = " ";
    expect(() => guideVideoScenes(edited, workflow)).toThrow(/every SOP step/);
  });
});
describe("video SOP review", () => {
  it("does not start until requested, saves first and downloads only on click", async () => {
    const p = platform(), save = vi.fn().mockResolvedValue(undefined);
    render(<GuideVideoPanel guide={guide} workflow={workflow} platform={p} save={save} />);
    expect(p.generate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Video SOP" }));
    fireEvent.click(screen.getByRole("button", { name: "Create video" }));
    await screen.findByLabelText("Narrated SOP preview");
    expect(save).toHaveBeenCalledWith(guide);
    expect(save.mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(p.generate).mock.invocationCallOrder[0]);
    expect(p.export).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Download MP4" }));
    await waitFor(() => expect(p.export).toHaveBeenCalledWith(result, guide.title, false));
  });
  it("prevents double submissions and cancels active generation when leaving", async () => {
    const p = platform(); let signal: AbortSignal | undefined;
    vi.mocked(p.generate).mockImplementation(async (_scenes, s) => { signal = s; return new Promise(() => {}); });
    const view = render(<GuideVideoPanel guide={guide} workflow={workflow} platform={p} save={async () => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Video SOP" }));
    fireEvent.click(screen.getByRole("button", { name: "Create video" }));
    fireEvent.click(screen.getByRole("button", { name: "Creating video…" }));
    await waitFor(() => expect(p.generate).toHaveBeenCalledTimes(1));
    view.unmount(); expect(signal?.aborted).toBe(true);
  });
  it("preserves an earlier preview when replacement fails and flags subsequent edits", async () => {
    const p = platform(), save = async () => {};
    const view = render(<GuideVideoPanel guide={guide} workflow={workflow} platform={p} save={save} />);
    fireEvent.click(screen.getByRole("button", { name: "Video SOP" }));
    fireEvent.click(screen.getByRole("button", { name: "Create video" }));
    await screen.findByLabelText("Narrated SOP preview");
    view.rerender(<GuideVideoPanel guide={{ ...guide, summary: "Updated instructions" }} workflow={workflow} platform={p} save={save} />);
    expect(screen.getByText(/earlier edit/)).toBeTruthy();
    vi.mocked(p.generate).mockImplementationOnce(async (_scenes, _signal, progress) => {
      progress("Narrating 2 of 8");
      throw new Error("Speech unavailable");
    });
    fireEvent.click(screen.getByRole("button", { name: "Create new video" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Speech unavailable");
    expect(screen.queryByText("Narrating 2 of 8")).toBeNull();
    expect(screen.getByLabelText("Narrated SOP preview")).toBeTruthy();
    expect(p.release).not.toHaveBeenCalled();
    view.unmount(); expect(p.release).toHaveBeenCalledWith(result);
  });
  it("does not render on save failure, and releases a late result after cancellation", async () => {
    const p = platform(); const save = vi.fn().mockRejectedValueOnce(new Error("Disk full"));
    render(<GuideVideoPanel guide={guide} workflow={workflow} platform={p} save={save} />);
    fireEvent.click(screen.getByRole("button", { name: "Video SOP" }));
    fireEvent.click(screen.getByRole("button", { name: "Create video" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Disk full");
    expect(p.generate).not.toHaveBeenCalled();
    save.mockResolvedValue(undefined);
    let resolve!: (value: typeof result) => void;
    vi.mocked(p.generate).mockImplementation(() => new Promise(r => { resolve = r; }));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await waitFor(() => expect(p.generate).toHaveBeenCalledTimes(1));
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    await act(async () => resolve(result));
    expect(p.release).toHaveBeenCalledWith(result);
    expect(screen.queryByLabelText("Narrated SOP preview")).toBeNull();
  });
});

it("renders the current chat-supplied script through the same preview controller", async () => {
  const p = platform(); const ref = React.createRef<import("../../../../packages/workflows-ui/src/guide-video-panel").GuideVideoHandle>();
  const { guideVideoDraft } = await import("../../../../packages/workflows-ui/src/guide-video");
  const video = guideVideoDraft(guide, workflow); video.scenes[0].narration = "Chat-edited narration.";
  const edited = { ...guide, video };
  render(<GuideVideoPanel ref={ref} guide={edited} workflow={workflow} platform={p} save={async()=>{}} />);
  await act(async()=>{await ref.current!.generate(edited,new AbortController().signal,()=>{});});
  expect(vi.mocked(p.generate).mock.calls[0][0][0].narration).toBe("Chat-edited narration.");
  expect(screen.getByLabelText("Narrated SOP preview")).toBeTruthy();
  expect(screen.queryByText(/earlier edit/)).toBeNull();
});

it("lets the assistant handle missing screenshots without a text-only checkbox",()=>{
 const p=platform(); const onCreate=vi.fn(); const without=structuredClone(workflow);without.stages[0].screenshot=undefined;without.stages[0].evidence=[];
 render(<GuideVideoPanel guide={guide} workflow={without} platform={p} save={async()=>{}} onCreate={onCreate} />);
 fireEvent.click(screen.getByRole("button",{name:"Video SOP"}));
 expect(screen.queryByText(/These steps need a screenshot/)).toBeNull();
 expect(screen.queryByRole("checkbox",{name:/Allow text-only/})).toBeNull();
 expect(screen.getByRole("button",{name:"Create video"})).toBeEnabled();
 fireEvent.click(screen.getByRole("button",{name:"Create video"}));
 expect(onCreate).toHaveBeenCalledOnce();
 expect(p.generate).not.toHaveBeenCalled();
});
it("keeps screenshot validation before speech and reports missing sources for direct generation",async()=>{
 const p=platform(); const save=vi.fn(); const without=structuredClone(workflow);without.stages[0].screenshot=undefined;without.stages[0].evidence=[];
 render(<GuideVideoPanel guide={guide} workflow={without} platform={p} save={save} />);
 fireEvent.click(screen.getByRole("button",{name:"Video SOP"}));
 fireEvent.click(screen.getByRole("button",{name:"Create video"}));
 expect(await screen.findByRole("alert")).toHaveTextContent(/Add screenshots/);
 expect(p.generate).not.toHaveBeenCalled();
 expect(save).not.toHaveBeenCalled();
 expect(screen.getByRole("button",{name:"Try again"})).toBeEnabled();
});
it("selects a verified screenshot even if the first capture is unreviewed",()=>{
 const w=structuredClone(workflow);w.stages[0].screenshots=[{...w.stages[0].screenshot!,frameId:7,visualVerified:false},{...w.stages[0].screenshot!,frameId:8,visualVerified:true}];
 expect(guideVideoScenes(guide,w)[0].imageFrameId).toBe(8);
});

it("retains earlier successful renders and releases only the oldest beyond three versions",async()=>{
 const p=platform();let number=0;vi.mocked(p.generate).mockImplementation(async()=>({...result,path:`/preview-${++number}.mp4`,url:`asset:/preview-${number}.mp4`}));
 const view=render(<GuideVideoPanel guide={guide} workflow={workflow} platform={p} save={async()=>{}} />);
 fireEvent.click(screen.getByRole("button",{name:"Video SOP"}));
 for(let i=1;i<=4;i++) { fireEvent.click(screen.getByRole("button",{name:i===1?"Create video":"Create new video"}));await waitFor(()=>expect(screen.getByLabelText("Narrated SOP preview")).toHaveAttribute("src",`asset:/preview-${i}.mp4`)); }
 expect(p.release).toHaveBeenCalledTimes(1);expect(vi.mocked(p.release).mock.calls[0][0].path).toBe("/preview-1.mp4");
 fireEvent.click(screen.getByText("Video revisions · 3"));fireEvent.click(screen.getByRole("button",{name:"Version 2"}));
 expect(screen.getByLabelText("Narrated SOP preview")).toHaveAttribute("src","asset:/preview-2.mp4");view.unmount();expect(p.release).toHaveBeenCalledTimes(4);
});


it("uses the step's explicit screenshot and never substitutes another when it expires", () => {
  const w = structuredClone(workflow);
  w.stages[0].screenshots = [{ ...w.stages[0].screenshot!, frameId: 8 }];
  const g = { ...guide, steps: [{ ...guide.steps[0], imageReview: { frameId: 5, timestamp: w.stages[0].screenshot!.timestamp } }] };
  expect(guideVideoScenes(g, w)[0].imageFrameId).toBe(5);
  w.stages[0].screenshot = undefined;
  expect(guideVideoScenes(g, w)[0].imageFrameId).toBeUndefined();
});
it("keeps an existing edited video's supporting sections until an explicit reset", () => {
  const video = guideVideoDraft(guide, workflow);
  video.scenes.unshift({ id: "section-0", title: guide.title, narration: "My custom introduction.", includeImage: false });
  expect(guideVideoScenes({ ...guide, video }, workflow)[0].narration).toBe("My custom introduction.");
  expect(guideVideoScenes(guide, workflow)).toHaveLength(1);
});
it("shows selected captures alongside narration without claiming semantic review", () => {
  const w = structuredClone(workflow);
  w.stages[0].screenshot!.dataUrl = "data:image/png;base64,YQ==";
  render(<GuideVideoPanel guide={guide} workflow={w} platform={platform()} save={async () => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Video SOP" }));
  expect(screen.getByRole("img", { name: "Screenshot for 1. Review sources" })).toHaveAttribute("src", w.stages[0].screenshot!.dataUrl);
  expect(screen.getByRole("region", { name: "Scene 1 narration block" })).toBeVisible();
  expect(screen.queryByText("Reviewed screenshot")).toBeNull();
  expect(screen.queryByText("Each step has its own reviewed screenshot.")).toBeNull();
});


it("lets legacy SOPs render their attached screenshots without a checkbox", async () => {
  const legacy = structuredClone(guide);
  legacy.steps[0].includeImage = false;
  const source = structuredClone(workflow);
  source.stages[0].screenshot!.visualVerified = false;
  const p = platform();
  render(<GuideVideoPanel guide={legacy} workflow={source} platform={p} save={async () => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Video SOP" }));
  expect(screen.queryByRole("checkbox")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Create video" }));
  await screen.findByLabelText("Narrated SOP preview");
  expect(p.generate).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ imageFrameId: 5 })]), expect.any(AbortSignal), expect.any(Function));
});

it("resolves unattached screen evidence automatically, but never audio or an explicitly removed image", () => {
 const source=structuredClone(workflow);source.stages[0].screenshot=undefined;
 const scenes=guideVideoScenes(guide,source);
 expect(scenes[0].imageSources?.length).toBeGreaterThan(0);
 expect(videoScreenshotGaps(scenes)).toEqual([]);
 const removed={...guide,steps:guide.steps.map(s=>({...s,imageExcluded:true}))};
 expect(videoScreenshotGaps(guideVideoScenes(removed,source))).toHaveLength(1);
 source.stages[0].evidence=source.stages[0].evidence.map(e=>({...e,source:"audio"}));
 expect(videoScreenshotGaps(guideVideoScenes(guide,source))).toHaveLength(1);
});

it("shows the storyboard and lets the chat bubble edit video without rendering", () => {
  const p = { ...platform(), edit: vi.fn() }, mode = vi.fn();
  render(<GuideVideoPanel guide={guide} workflow={workflow} platform={p} save={async () => {}} onVideoMode={mode} />);
  fireEvent.click(screen.getByRole("button", { name: "Video SOP" }));
  expect(screen.getByRole("region", { name: "Scene 1 narration block" })).toBeVisible();
  expect(screen.getByText(/Check each claim/)).toBeVisible();
  expect(screen.queryByRole("button", { name: "Edit video in chat" })).toBeNull();
  act(() => window.dispatchEvent(new CustomEvent("workflows:assistant-opened")));
  expect(mode).toHaveBeenCalledWith(true);
  expect(screen.getByRole("region", { name: "Video SOP" })).toBeVisible();
  expect(p.generate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Back to SOP" }));
  expect(mode).toHaveBeenLastCalledWith(false);
  expect(screen.getByRole("button", { name: "Video SOP" })).toHaveFocus();
});
it("loads the original screenshot for frame-only storyboard scenes and releases it on close", async () => {
  const load = vi.fn().mockResolvedValue("blob:storyboard-original");
  const originalRevoke = URL.revokeObjectURL;
  const revoke = vi.fn();
  URL.revokeObjectURL = revoke;
  render(<GuideVideoPanel guide={guide} workflow={workflow} platform={platform()} loadScreenshot={load} save={async () => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Video SOP" }));
  await waitFor(() => expect(screen.getByRole("img", { name: "Screenshot for 1. Review sources" })).toHaveAttribute("src", "blob:storyboard-original"));
  expect(load).toHaveBeenCalledWith(5, expect.any(AbortSignal));
  fireEvent.click(screen.getByRole("button", { name: "Back to SOP" }));
  expect(load.mock.calls[0][1].aborted).toBe(true);
  expect(revoke).toHaveBeenCalledWith("blob:storyboard-original");
  URL.revokeObjectURL = originalRevoke;
});

it("reconnects a stale SOP without rewriting its text, then follows pinned frames across reordered revisions", () => {
  const stale = { ...guide, sourceRevision: 0 };
  const fixed = reconnectGuideSources(stale, workflow, [0]);
  expect(fixed.summary).toBe(stale.summary);
  expect(fixed.steps[0].instruction).toBe(stale.steps[0].instruction);
  expect(fixed.steps[0].imageReview).toEqual({ frameId: 5, timestamp: workflow.stages[0].screenshot!.timestamp });
  const changed = { ...workflow, revision: 3, stages: [...workflow.stages].reverse() };
  expect(guideVideoScenes(fixed, changed)[0].imageFrameId).toBe(5);
  const missing = { ...changed, stages: [] };
  expect(() => guideVideoScenes(fixed, missing)).toThrow(/screenshot links/);
  expect(() => reconnectGuideSources(stale, workflow, [999])).toThrow(/Choose a current/);
});
it("keeps edited narration and scene order when reconnecting sources, and resets old focus coordinates", () => {
  const video = guideVideoDraft(guide, workflow);
  video.scenes[0].narration = "My own narration.";
  video.scenes[0].focus = { x: 0.2, y: 0.3, zoom: 1.2 };
  const changed = { ...workflow, revision: 3 };
  const next = reconnectGuideSources({ ...guide, video }, changed, [0]);
  expect(next.video!.scenes[0].narration).toBe("My own narration.");
  expect(next.video!.scenes[0].focus).toBeNull();
  expect(guideVideoScenes(next, changed)[0].narration).toBe("My own narration.");
});
it("shows real step counts and a recovery action when the catalog revision changed", async () => {
  const p = platform(), save = vi.fn().mockResolvedValue(undefined);
  function Reopen() {
    const [draft, setDraft] = React.useState({ ...guide, sourceRevision: 0 });
    return <GuideVideoPanel guide={draft} workflow={workflow} platform={p} save={save} onReconnect={async next => { await save(next); setDraft(next); }} />;
  }
  render(<Reopen />);
  fireEvent.click(screen.getByRole("button", { name: "Video SOP" }));
  expect(screen.getByText("1 step · Narrated walkthrough")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Create video" })).toBeDisabled();
  expect(screen.queryByRole("combobox")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Review screenshots" }));
  expect(screen.getByRole("combobox", { name: "Screenshot source for step 1" })).toBeTruthy();
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "none" } });
  fireEvent.click(screen.getByRole("button", { name: "Close review" }));
  expect(screen.queryByRole("combobox")).toBeNull();
  expect(save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Review screenshots" }));
  expect(screen.getByRole("combobox")).toHaveValue("none");
  fireEvent.change(screen.getByRole("combobox"), { target: { value: "0" } });
  fireEvent.click(screen.getByRole("button", { name: "Save screenshot choices" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Create video" })).toBeEnabled());
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ sourceRevision: 2 }));
  expect(p.generate).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Create video" }));
  await screen.findByLabelText("Narrated SOP preview");
});
it("keeps source review open and generation blocked when saving the reconnection fails", async () => {
  const p = platform();
  render(<GuideVideoPanel guide={{ ...guide, sourceRevision: 0 }} workflow={workflow} platform={p} save={async () => {}} onReconnect={async () => { throw new Error("Disk full"); }} />);
  fireEvent.click(screen.getByRole("button", { name: "Video SOP" }));
  fireEvent.click(screen.getByRole("button", { name: "Review screenshots" }));
  fireEvent.click(screen.getByRole("button", { name: "Save screenshot choices" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("Disk full");
  expect(screen.getByRole("button", { name: "Create video" })).toBeDisabled();
  expect(p.generate).not.toHaveBeenCalled();
});

it("loads timestamp-only storyboard sources on opening and releases the original on close", async () => {
  const source = structuredClone(workflow); source.stages[0].screenshot = undefined;
  const originalRevoke = URL.revokeObjectURL; const revoke = vi.fn(); URL.revokeObjectURL = revoke;
  const loadSourceScreenshot = vi.fn().mockResolvedValue({ frameId: 42, dataUrl: "blob:resolved-original" });
  try {
    render(<GuideVideoPanel guide={guide} workflow={source} platform={platform()} loadSourceScreenshot={loadSourceScreenshot} save={async () => {}} />);
    expect(loadSourceScreenshot).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Video SOP" }));
    await waitFor(() => expect(screen.getByRole("img", { name: "Screenshot for 1. Review sources" })).toHaveAttribute("src", "blob:resolved-original"));
    const expected = guideVideoScenes(guide, source)[0].imageSources![0];
    expect(loadSourceScreenshot).toHaveBeenCalledWith(expected.timestamp, expected.app, expect.any(AbortSignal));
    expect(screen.queryByText("Screenshot will load from the recording")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Back to SOP" }));
    expect(loadSourceScreenshot.mock.calls[0][2].aborted).toBe(true);
    expect(revoke).toHaveBeenCalledWith("blob:resolved-original");
  } finally { URL.revokeObjectURL = originalRevoke; }
});
it("reports unavailable recording previews and retries without starting video generation", async () => {
  const source = structuredClone(workflow); source.stages[0].screenshot = undefined;
  const loadSourceScreenshot = vi.fn().mockResolvedValue(null); const p = platform();
  render(<GuideVideoPanel guide={guide} workflow={source} platform={p} loadSourceScreenshot={loadSourceScreenshot} save={async () => {}} />);
  fireEvent.click(screen.getByRole("button", { name: "Video SOP" }));
  await screen.findByText("No captured screenshot available for this step.");
  expect(screen.queryByText("Loading screenshot…")).toBeNull();
  loadSourceScreenshot.mockResolvedValue({ frameId: 42, dataUrl: "data:image/png;base64,YQ==" });
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  await screen.findByRole("img", { name: "Screenshot for 1. Review sources" });
  expect(p.generate).not.toHaveBeenCalled();
});

it("persists a selected source for a previously unlinked step without changing SOP instructions",()=>{
 const g={...guide,steps:[guide.steps[0],{...guide.steps[0],title:"Continue",sourceStage:null}]};
 const video=guideVideoDraft(g,workflow);const sourceId=video.scenes[0].id;
 video.scenes[1]={...video.scenes[1],includeImage:true,imageSourceId:sourceId};
 const saved=parseGuide(JSON.parse(JSON.stringify({...g,video})));
 const scenes=guideVideoScenes(saved,workflow);
 expect(scenes[1].imageFrameId).toBe(5);expect(scenes[1].imageSourceId).toBe(sourceId);
 expect(saved.steps[1].sourceStage).toBeNull();expect(scenes[1].narration).toBe(scenes[0].narration);
 saved.video!.scenes[1].imageSourceId="section-999";
 expect(()=>guideVideoScenes(saved,workflow)).toThrow(/SOP changed/);
});
