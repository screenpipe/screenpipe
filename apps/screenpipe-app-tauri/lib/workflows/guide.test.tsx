// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import React from "react";
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react";
import {
  guideHtml,
  guidePrompt,
  parseGuide,
  type WorkflowGuide as Guide,
} from "../../../../packages/workflows-ui/src/guide";
import { WorkflowGuide } from "../../../../packages/workflows-ui/src/workflow-guide";
import { fixtureWorkflowAnalysis } from "../../../../packages/workflows-ui/src/fixture-platform";
const workflow = structuredClone(fixtureWorkflowAnalysis.analysis.workflows[0]);
workflow.id = "research";
workflow.revision = 3;
workflow.stages[0].screenshot = {
  frameId: 1,
  visualVerified: true,
  app: "Docs",
  timestamp: "2026-09-16T10:00:00Z",
  matchDistanceSeconds: 0,
  dataUrl: "data:image/png;base64,YQ==",
};
const guide: Guide = {
  version: 1,
  workflowKey: "research",
  sourceRevision: 3,
  title: "Research guide",
  summary: "Make findings traceable.",
  prerequisites: ["A research question"],
  steps: [
    {
      title: "Collect sources",
      instruction: "Gather the documents.",
      sourceStage: 0,
      includeImage: true,
      expectedResult: "Sources collected",
    },
    {
      title: "Review",
      instruction: "Compare findings.",
      sourceStage: 1,
      includeImage: false,
      expectedResult: "",
    },
  ],
  exceptions: [],
  completion: ["Sources are linked"],
  questions: ["Who reviews this?"],
};
afterEach(cleanup);
describe("guide contracts and export", () => {
  it("rejects invented source stages and another workflow identity", () => {
    expect(() =>
      parseGuide({ ...guide, workflowKey: "another" }, workflow),
    ).toThrow();
    expect(() =>
      parseGuide(
        { ...guide, steps: [{ ...guide.steps[0], sourceStage: 99 }] },
        workflow,
      ),
    ).toThrow();
  });
  it("escapes captured markup and requires explicit image inclusion", () => {
    const unsafe = {
      ...guide,
      title: "<script>alert(1)</script>",
      summary: '<img src="https://private.example/leak">',
    };
    const html = guideHtml(unsafe, workflow, false);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<img ");
    expect(guideHtml(guide, workflow, true)).toContain(
      'src="data:image/png;base64,YQ=="',
    );
  });
  it("omits unverified, remote, and revision-mismatched screenshots", () => {
    for (const screenshot of [
      { ...workflow.stages[0].screenshot!, visualVerified: false },
      {
        ...workflow.stages[0].screenshot!,
        dataUrl: "https://example.com/tracker",
      },
    ]) {
      const w = {
        ...workflow,
        stages: [
          { ...workflow.stages[0], screenshot },
          ...workflow.stages.slice(1),
        ],
      };
      expect(guideHtml(guide, w, true)).not.toContain("<img ");
    }
    expect(guideHtml(guide, { ...workflow, revision: 4 }, true)).not.toContain(
      "<img ",
    );
  });
  it("keeps image payloads and local paths out of the agent prompt", () => {
    expect(guidePrompt(workflow)).not.toContain("data:image");
    expect(guidePrompt(workflow)).toContain("Do not execute the workflow");
  });
});
describe("guide editor", () => {
  const host = () => ({
    load: vi.fn(async () => structuredClone(guide)),
    save: vi.fn(async () => {}),
    generate: vi.fn(async () => structuredClone(guide)),
    export: vi.fn(async () => true),
  });
  it("opens a saved draft without spending another generation and saves edits", async () => {
    const platform = host();
    render(
      <WorkflowGuide
        workflow={workflow}
        platform={platform}
        close={() => {}}
      />,
    );
    await screen.findByRole("heading", { name: "Research guide" });
    expect(platform.generate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Edit SOP" }));
    fireEvent.change(screen.getByLabelText("Guide title"), {
      target: { value: "Team research handbook" },
    });
    await waitFor(() =>
      expect(platform.save).toHaveBeenLastCalledWith(
        expect.objectContaining({ title: "Team research handbook" }),
      ),
    );
    fireEvent.click(screen.getByRole("button", { name: "Move step 2 up" }));
    await waitFor(() =>
      expect(platform.save.mock.calls.at(-1)?.[0].steps[0].title).toBe(
        "Review",
      ),
    );
  });
  it("scrolls guide sections without changing the host route", async () => {
    const scroll = vi.fn();
    render(
      <WorkflowGuide workflow={workflow} platform={host()} close={() => {}} />,
    );
    await screen.findByRole("heading", { name: "Research guide" });
    document.getElementById("guide-completion")!.scrollIntoView = scroll;
    const event = new MouseEvent("click", { bubbles: true, cancelable: true });
    screen
      .getByRole("link", { name: "Check your result" })
      .dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    expect(scroll).toHaveBeenCalled();
  });
  it("retries a failed disk read before spending another generation", async () => {
    const platform = {
      ...host(),
      load: vi
        .fn()
        .mockRejectedValueOnce(new Error("disk unavailable"))
        .mockResolvedValueOnce(guide),
    };
    render(
      <WorkflowGuide
        workflow={workflow}
        platform={platform}
        close={() => {}}
      />,
    );
    await screen.findByText(
      "Your saved guide could not be opened. Its files are unchanged.",
    );
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("heading", { name: "Research guide" });
    expect(platform.generate).not.toHaveBeenCalled();
  });
  it("aborts generation on exit and ignores late results", async () => {
    let signal: AbortSignal | undefined;
    let finish!: (g: Guide) => void;
    const platform = {
      ...host(),
      load: vi.fn(async () => null),
      generate: vi.fn((_w, s) => {
        signal = s;
        return new Promise<Guide>((r) => (finish = r));
      }),
    };
    const view = render(
      <WorkflowGuide
        workflow={workflow}
        platform={platform}
        close={() => {}}
      />,
    );
    await waitFor(() => expect(signal).toBeDefined());
    view.unmount();
    expect(signal?.aborted).toBe(true);
    finish(guide);
    await Promise.resolve();
    expect(platform.save).not.toHaveBeenCalled();
  });
  it("shows retryable generation and persistence failures", async () => {
    const platform = {
      ...host(),
      load: vi.fn(async () => null),
      generate: vi
        .fn()
        .mockRejectedValueOnce(new Error("Account unavailable"))
        .mockResolvedValueOnce(guide),
      save: vi.fn().mockRejectedValue(new Error("disk full")),
    };
    render(
      <WorkflowGuide
        workflow={workflow}
        platform={platform}
        close={() => {}}
      />,
    );
    await screen.findByText("Account unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await screen.findByRole("heading", { name: "Research guide" });
    await screen.findByRole("button", { name: "Retry save" });
  });
});

describe("SOP assistant and web editor", () => {
  it("requires review before sending SOP text to the web editor", async () => {
    const openWeb = vi.fn().mockResolvedValue(undefined);
    render(
      <WorkflowGuide
        workflow={workflow}
        close={() => {}}
        platform={{
          load: async () => guide,
          generate: vi.fn(),
          save: vi.fn(),
          export: vi.fn(),
          openWeb,
        }}
      />,
    );
    fireEvent.click(await screen.findByText("Open web editor"));
    expect(openWeb).not.toHaveBeenCalled();
    expect(screen.queryByText("Create a short video")).not.toBeInTheDocument();
    fireEvent.click(screen.getByText("Continue to web editor"));
    await waitFor(() => expect(openWeb).toHaveBeenCalledWith(guide));
  });
  it("edits with the existing harness adapter and cancels an in-flight edit", async () => {
    let signal: AbortSignal | undefined;
    const edit = vi.fn((_g, _w, _q, s) => {
      signal = s;
      return new Promise<Guide>(() => {});
    });
    render(
      <WorkflowGuide
        workflow={workflow}
        close={() => {}}
        platform={{
          load: async () => guide,
          generate: vi.fn(),
          save: vi.fn(),
          export: vi.fn(),
          edit,
        }}
      />,
    );
    const input = await screen.findByLabelText(
      "Ask Screenpipe to edit the SOP",
    );
    fireEvent.change(input, { target: { value: "Make it shorter" } });
    fireEvent.click(screen.getByLabelText("Edit with Screenpipe"));
    expect(edit.mock.calls[0][2]).toBe("Make it shorter");
    fireEvent.click(screen.getByText("Stop"));
    expect(signal?.aborted).toBe(true);
    expect(screen.getByText("Stopped. Your SOP is saved.")).toBeInTheDocument();
  });
});
