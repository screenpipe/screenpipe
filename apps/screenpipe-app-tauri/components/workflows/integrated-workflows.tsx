// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
"use client";

import { useCallback, useState } from "react";
import { ConnectedShareDialog } from "@/components/connected-share-dialog";
import { createWorkflowShareArtifact, type ConnectedShareArtifact } from "@/lib/connected-share";
import { TooltipProvider } from "@/components/ui/tooltip";
import { WorkflowsApp, type WorkflowsAppProps, type WorkflowMap } from "@screenpipe/workflows-ui";
import { createFixtureWorkflowsPlatform } from "@screenpipe/workflows-ui/fixture";
import { desktopWorkflowsPlatform } from "@/lib/workflows/desktop-platform";
import { ProductSwitcher, type ProductMode } from "./product-switcher";
import { WorkflowTasksPrompt } from "./workflow-tasks-prompt";

// Only the existing browser-mock build gets synthetic data. Native builds use
// the parent PR's adapter, native recorder and app-local persistent storage.
const platform = process.env.NEXT_PUBLIC_SCREENPIPE_WEB_DEV === "mock"
  ? createFixtureWorkflowsPlatform()
  : desktopWorkflowsPlatform;
export function IntegratedWorkflows({ active, onModeChange, recordingStatus, navigationFooter }: { active: boolean; onModeChange: (mode: ProductMode) => void; recordingStatus: React.ReactNode; navigationFooter?: WorkflowsAppProps["navigationFooter"] }) {
  const [shareArtifact, setShareArtifact] = useState<ConnectedShareArtifact | null>(null);
  const openShare = useCallback((workflow: WorkflowMap) => setShareArtifact(createWorkflowShareArtifact(workflow)), []);
  return <TooltipProvider>{shareArtifact && <ConnectedShareDialog open={active} onOpenChange={open => { if (!open) setShareArtifact(null); }} artifact={shareArtifact} />}{platform.managesAnalysis && <WorkflowTasksPrompt active={active} />}<WorkflowsApp onShareWorkflow={openShare} platform={platform} active={active} storageKey={null} recordingStatus={recordingStatus} navigationFooter={navigationFooter}
    navigationBrand={<ProductSwitcher mode="workflows" onChange={onModeChange} />} /></TooltipProvider>;
}
