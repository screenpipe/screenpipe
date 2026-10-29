// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import {render,waitFor,screen,cleanup} from "@testing-library/react";
import {expect,it,vi,afterEach} from "vitest";
const captured=vi.hoisted(()=>({props:null as any}));
vi.mock("@/components/rewind/ai-presets-selector",()=>({AIPresetsSelector:(props:any)=>{captured.props=props;return <button>{props.selectionLabel}</button>}}));
vi.mock("@/lib/workflows/model-choice",()=>({workflowModelPreference:{load:async()=>"intelligent",save:vi.fn()}}));
vi.mock("@/lib/hooks/use-managed-policy",()=>({useManagedPolicy:()=>({isManagedDeployment:false,policy:{}})}));
import {WorkflowModelSelector} from "./workflow-model-selector";
afterEach(cleanup);
it("offers Intelligent and custom presets without Private",async()=>{
 render(<WorkflowModelSelector/>);
 await waitFor(()=>expect(captured.props.builtinOptions.map((o:any)=>o.id)).toEqual(["workflow-intelligent"]));
 expect(captured.props.presetFilter({provider:"screenpipe-cloud",model:"glm-5.3-flash-reap50-iq3m"})).toBe(false);
 expect(captured.props.presetFilter({provider:"custom",model:"glm-5.3-flash-reap50-iq3m"})).toBe(true);
});
it("labels a legacy saved Private selection as retired without saving a replacement",async()=>{
 const save=vi.fn();render(<WorkflowModelSelector preference={{load:async()=>"private",save}}/>);
 await waitFor(()=>expect(screen.getByRole("button")).toHaveTextContent("Private (retired)"));
 expect(save).not.toHaveBeenCalled();
});
