// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com

"use client";

import { WorkflowsApp } from "@screenpipe/workflows-ui";
import {
  createFixtureEnterpriseWorkflowsPlatform,
  fixtureWorkflowAnalysis,
} from "@screenpipe/workflows-ui/fixture";

const enterprisePlatform = createFixtureEnterpriseWorkflowsPlatform();

export default function EnterpriseWorkflowsPreviewPage() {
  return (
    <WorkflowsApp
      platform={enterprisePlatform}
      initialAnalysis={{
        ...fixtureWorkflowAnalysis,
        scope: { id: "organization", kind: "organization", label: "Organization" },
        processing: { location: "confidential-cloud", label: "Confidential cloud" },
      }}
      initialScopeId="organization"
      storageKey={null}
    />
  );
}
