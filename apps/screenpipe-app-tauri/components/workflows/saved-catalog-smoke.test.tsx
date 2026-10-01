// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import React from "react";
import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { WorkflowsApp } from "@screenpipe/workflows-ui";
import { createFixtureWorkflowsPlatform } from "@screenpipe/workflows-ui/fixture";
import type { WorkflowAnalysis } from "@screenpipe/workflows-ui/model";

// Opt-in local regression probe. No catalog content is checked in or transmitted.
const catalogPath = process.env.WORKFLOW_CATALOG_TEST_PATH;
it.skipIf(!catalogPath)("opens every workflow in a saved catalog", async () => {
  const catalog = JSON.parse(readFileSync(catalogPath!, "utf8")) as WorkflowAnalysis;
  const guidesPath = process.env.WORKFLOW_GUIDES_TEST_PATH;
  const guides = guidesPath ? JSON.parse(readFileSync(guidesPath, "utf8")) : {};
  let openedGuides = 0;
  expect(catalog.analysis.workflows.length).toBeGreaterThan(0);
  for (const workflow of catalog.analysis.workflows) {
    localStorage.clear();
    window.history.replaceState(null, "", "/home?mode=workflows");
    const single = { ...catalog, analysis: { ...catalog.analysis, workflows: [workflow] } };
    const platform = createFixtureWorkflowsPlatform(single);
    platform.loadCapturedWork = async () => single;
    const guide = workflow.id ? guides[workflow.id] : undefined;
    if (guide && platform.guides) platform.guides.load = async () => guide;
    render(<WorkflowsApp platform={platform} embedded />);
    const card = (await screen.findByRole("heading", { name: workflow.title })).closest("article")!;
    fireEvent.click(within(card).getByRole("button", { name: "Open map" }));
    expect(await screen.findByRole("button", { name: "Create SOP" })).toBeVisible();
    expect(screen.getByRole("textbox", { name: "Workflow title" })).toHaveValue(workflow.title);
    if (guide) {
      fireEvent.click(screen.getByRole("button", { name: "Create SOP" }));
      expect(await screen.findByLabelText("Saved on this device")).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Back to workflow" })).toBeVisible();
      openedGuides++;
    }
    cleanup();
  }
  if (guidesPath) expect(openedGuides).toBeGreaterThan(0);
}, 60000);
