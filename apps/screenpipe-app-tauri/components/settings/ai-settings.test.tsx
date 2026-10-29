// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import {render,screen,fireEvent} from "@testing-library/react";
import {expect,it,vi} from "vitest";
const mocks=vi.hoisted(()=>({update:vi.fn(),media:vi.fn(),enhanced:vi.fn()}));
vi.mock("@/lib/hooks/use-settings",()=>({useSettings:()=>({settings:{enhancedAI:true,cloudMediaAnalysisEnabled:true,autoGenerateChatTitles:true},updateSettings:mocks.update})}));
vi.mock("@/lib/utils/tauri",()=>({commands:{setCloudMediaAnalysisSkill:mocks.media,setEnhancedAiSuggestions:mocks.enhanced}}));
import {AISettings,searchIndex} from "./ai-settings";
it("removes retired media controls even with an old enabled setting, preserving other preferences",()=>{
 render(<AISettings/>);
 expect(screen.queryByText("AI audio & video analysis")).toBeNull();
 expect(document.getElementById("cloudMediaAnalysisEnabled")).toBeNull();
 expect(mocks.media).not.toHaveBeenCalled();
 expect(JSON.stringify(searchIndex)).not.toContain("video analysis");
 const toggle=document.getElementById("auto-generate-chat-titles-toggle")!;
 expect(toggle).toBeTruthy();fireEvent.click(toggle);
 expect(mocks.update).toHaveBeenCalledWith({autoGenerateChatTitles:false});
 expect(document.getElementById("enhanced-ai-toggle")).toBeTruthy();
});
