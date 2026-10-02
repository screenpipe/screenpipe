// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import React from "react";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GuideAssistant } from "../../../../packages/workflows-ui/src/guide-assistant";
import { PageAssistantContext, type PageAssistant } from "../../../../packages/workflows-ui/src/page-assistant";
import { applyVideoEdit, parseVideoEdit, parseVideoDraft } from "../../../../packages/workflows-ui/src/video-tool";
import { guideVideoDraft, guideVideoScenes } from "../../../../packages/workflows-ui/src/guide-video";
import { parseGuide, type WorkflowGuide } from "../../../../packages/workflows-ui/src/guide";
import { fixtureWorkflowAnalysis } from "../../../../packages/workflows-ui/src/fixture-platform";
const workflow = fixtureWorkflowAnalysis.analysis.workflows[0];
const guide: WorkflowGuide = { version: 1, workflowKey: workflow.id || workflow.title, sourceRevision: workflow.revision ?? 0, title: "Research", summary: "Read the sources carefully.", prerequisites: [], steps: [{ title: "Collect", instruction: "Collect the sources and review every claim.", expectedResult: "Each claim has a reference.", sourceStage: null, includeImage: false }], exceptions: [], completion: ["The brief is reviewed."], questions: [] };
afterEach(cleanup);
describe("video script patches", () => {
 it("edits and reorders video text independently, round-trips through SOP storage validation", () => {
  const initial = guideVideoDraft(guide, workflow);
  // A previously edited project can retain its custom introduction.
  initial.scenes.unshift({id:"section-0",title:guide.title,narration:guide.summary,includeImage:false});
  const video = applyVideoEdit(initial, {changes:[{id:"section-1",narration:"Review each claim."}],order:["section-1","section-0"],render:false});
  const saved = parseGuide(JSON.parse(JSON.stringify({...guide,video})));
  expect(saved.steps).toEqual(guide.steps);
  expect(saved.video).toEqual(video);
  expect(guideVideoScenes(saved,workflow).map(s=>s.narration)).toEqual(["Review each claim.",guide.summary]);
  expect(() => guideVideoDraft({...saved,summary:"Changed source"},workflow)).toThrow(/SOP changed/);
 });
 it("rejects unknown IDs, duplicate patches, arbitrary fields, invalid drafts and oversized narration", () => {
  const draft = guideVideoDraft(guide,workflow);
  for(const input of [{changes:[{id:"section-99",title:"Wrong"}],render:false},{changes:[],order:["section-0","section-0"],render:false},{changes:[{id:"section-0",image:"https://example.com"}],render:false},{changes:[{id:"section-0",narration:"a".repeat(18001)}],render:false}]) expect(()=>applyVideoEdit(draft,input)).toThrow();
  expect(()=>parseVideoEdit({changes:[],render:"yes"})).toThrow();
  expect(()=>parseVideoDraft({...draft,scenes:[]})).toThrow();
 });
 it("never permits a patch to invent screenshot approval", () => {
  const video=applyVideoEdit(guideVideoDraft(guide,workflow),{changes:[{id:"section-1",includeImage:true}],render:false});
  expect(guideVideoScenes({...guide,video},workflow)[0].image).toBeNull();
  expect(guideVideoScenes({...guide,video},workflow)[0].imageFrameId).toBeUndefined();
 });
});
function setup(edit: any, update=vi.fn(async()=>{}), renderVideo=vi.fn(async()=>{})) {
 let page: PageAssistant | null=null;
 const register=vi.fn((value:any)=>{page=value;});
 const platform:any={edit:vi.fn(),video:{edit}};
 const props={guide,workflow,platform,update,renderVideo,videoMode:true};
 const view=render(<PageAssistantContext.Provider value={register}><GuideAssistant {...props}/></PageAssistantContext.Provider>);
 return {view,props,update,renderVideo,page:()=>page!,ask:()=>page!.ask({question:"Make it shorter",context:page!.context,history:[],signal:new AbortController().signal,onProgress:vi.fn()})};
}
describe("bottom-right video chat",()=>{
 it("saves edits without rendering or changing the SOP",async()=>{
  const draft=applyVideoEdit(guideVideoDraft(guide,workflow),{changes:[{id:"section-1",narration:"Review sources."}],render:false});
  const s=setup(vi.fn(async()=>({draft,changed:true,render:false,message:"Proposed"})));
  await act(async()=>{expect(await s.ask()).toContain("Saved the video script");});
  expect(s.page().context.purpose).toBe("video");
  expect(s.update).toHaveBeenCalledWith({...guide,video:draft});
  expect(s.renderVideo).not.toHaveBeenCalled();
 });
 it("saves first, then renders only the validated edited script",async()=>{
  const draft=guideVideoDraft(guide,workflow);
  const s=setup(vi.fn(async()=>({draft,changed:false,render:true,message:""})));
  await act(async()=>{expect(await s.ask()).toContain("Your video is ready on the page");});
  expect(s.update.mock.invocationCallOrder[0]).toBeLessThan(s.renderVideo.mock.invocationCallOrder[0]);
  expect(s.renderVideo).toHaveBeenCalledWith({...guide,video:draft},expect.any(AbortSignal),expect.any(Function));
 });
 it("does not render on save failure",async()=>{
  const s=setup(vi.fn(async()=>({draft:guideVideoDraft(guide,workflow),changed:true,render:true,message:""})),vi.fn(async()=>{throw new Error("Disk full");}));
  await expect(s.ask()).rejects.toThrow("Disk full");expect(s.renderVideo).not.toHaveBeenCalled();
 });
 it("rejects a stale asynchronous edit after a manual edit",async()=>{
  let resolve:any;const s=setup(vi.fn(()=>new Promise(r=>{resolve=r;})));
  const pending=s.ask();
  s.view.rerender(<PageAssistantContext.Provider value={null}><GuideAssistant {...s.props} guide={{...guide,summary:"Manual edit"}}/></PageAssistantContext.Provider>);
  resolve({draft:guideVideoDraft(guide,workflow),changed:true,render:false,message:""});
  await expect(pending).rejects.toThrow();expect(s.update).not.toHaveBeenCalled();
 });
 it("answers questions without writes",async()=>{
  const s=setup(vi.fn(async()=>({draft:guideVideoDraft(guide,workflow),changed:false,render:false,message:"This video has three sections."})));
  expect(await s.ask()).toContain("three sections");expect(s.update).not.toHaveBeenCalled();expect(s.renderVideo).not.toHaveBeenCalled();
 });
});
