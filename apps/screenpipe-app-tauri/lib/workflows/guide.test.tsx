// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import React, { useState } from "react";
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
import { sanitizeWorkflowAnalysis } from "../../../../packages/workflows-ui/src/catalog";
import { PageAssistantContext, type PageAssistant } from "../../../../packages/workflows-ui/src/page-assistant";
import { WorkflowAssistant } from "@screenpipe/workflows-ui";
import { emptyAssistantState } from "../../../../packages/workflows-ui/src/assistant";
import type { WorkflowsPlatform } from "../../../../packages/workflows-ui/src/platform";
function GuideChat({ edit, save = vi.fn(), previousFeedback = false }: { edit: NonNullable<WorkflowsPlatform["guides"]>["edit"]; save?: ReturnType<typeof vi.fn>; previousFeedback?: boolean }) {
  const previous = emptyAssistantState();
  previous.conversations[0].feedbackContext = { key: "feedback:research", title: workflow.title, workflow, purpose: "feedback" };
  previous.conversations[0].draft = "Keep this feedback draft";
  const [page, setPage] = useState<PageAssistant | null>(null);
  return <PageAssistantContext.Provider value={setPage}>
    <WorkflowGuide workflow={workflow} close={() => {}} platform={{ load: async () => guide, generate: vi.fn(), save, export: vi.fn(), edit }} />
    {page && <WorkflowAssistant context={page.context} onDockChange={() => {}} platform={{ load: async () => previousFeedback ? previous : null, save: async () => {}, ask: page.ask }} />}
  </PageAssistantContext.Provider>;
}
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
  it("keeps older images through catalog loading without counting them as verified evidence", () => {
    const catalog = structuredClone(fixtureWorkflowAnalysis);
    catalog.analysis.workflows = [catalog.analysis.workflows[0]];
    const stage = catalog.analysis.workflows[0].stages[0];
    stage.screenshot = {
      ...workflow.stages[0].screenshot!,
      visualVerified: undefined,
    };
    const clean = sanitizeWorkflowAnalysis(catalog);
    expect(clean.analysis.workflows[0].stages[0].screenshot).toEqual(
      stage.screenshot,
    );
    expect(clean.analysis.workflows[0].quality.screenshotCount).toBe(2);
  });
  it("round-trips multiple screenshots and counts images separately from covered steps", () => {
    const catalog = structuredClone(fixtureWorkflowAnalysis);
    const w = catalog.analysis.workflows[0];
    catalog.analysis.workflows = [w];
    const first = w.stages[0].screenshot!;
    w.stages[0].screenshots = [first, { ...first, frameId: 901 }, { ...first, frameId: 902 }];
    w.stages[1].screenshot = null;
    w.stages[2].screenshot = null;
    const clean = sanitizeWorkflowAnalysis(JSON.parse(JSON.stringify(catalog)));
    expect(clean.analysis.workflows[0].stages[0].screenshots).toEqual(w.stages[0].screenshots);
    expect(clean.analysis.workflows[0].quality.screenshotCount).toBe(3);
    expect(clean.analysis.workflows[0].quality.stageScreenshotCoverage).toBe(33);
    expect(clean.quality.screenshotCount).toBe(3);
    expect(clean.quality.screenshotCoverage).toBe(33);
  });
  it("persists human review, but never accepts it from generated output or for another source", () => {
    const w = structuredClone(workflow);
    delete w.stages[0].screenshot!.visualVerified;
    const reviewed = structuredClone(guide);
    reviewed.steps[0].imageReview = {
      frameId: 1,
      timestamp: w.stages[0].screenshot!.timestamp,
    };
    const reopened = parseGuide(JSON.parse(JSON.stringify(reviewed)));
    expect(guideHtml(reopened, w, true)).toContain("<img ");
    expect(guideHtml(reopened, w, false)).not.toContain("<img ");
    expect(guideHtml(parseGuide(reviewed, w), w, true)).not.toContain("<img ");
    w.stages[0].screenshot!.frameId = 2;
    expect(guideHtml(reopened, w, true)).not.toContain("<img ");
    w.stages[0].screenshot!.frameId = 1;
    expect(guideHtml(reopened, { ...w, revision: 4 }, true)).not.toContain(
      "<img ",
    );
    w.stages[0].screenshot!.dataUrl = "https://example.com/tracker";
    expect(guideHtml(reopened, w, true)).not.toContain("<img ");
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
  it("lets an older saved SOP review and include a local screenshot without regenerating", async () => {
    const w = structuredClone(workflow);
    delete w.stages[0].screenshot!.visualVerified;
    w.stages[1].screenshot = undefined;
    const oldGuide = structuredClone(guide);
    oldGuide.steps[0].includeImage = false;
    const platform = { ...host(), load: vi.fn(async () => oldGuide) };
    const view = render(
      <WorkflowGuide workflow={w} platform={platform} close={() => {}} />,
    );
    await screen.findByRole("heading", { name: "Research guide" });
    expect(screen.queryByRole("img")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Review screenshot" }));
    const preview = screen.getByRole("img", {
      name: "Review source for Collect sources",
    });
    const include = screen.getByRole("button", { name: "Include screenshot" });
    expect(include).toBeDisabled();
    fireEvent.load(preview);
    fireEvent.click(include);
    await screen.findByRole("img", { name: "Source for Collect sources" });
    await waitFor(() => expect(platform.save).toHaveBeenCalled());
    const saved = parseGuide(
      JSON.parse(JSON.stringify(platform.save.mock.calls.at(-1)![0])),
    );
    expect(saved.steps[0].includeImage).toBe(true);
    expect(saved.steps[0].imageReview?.frameId).toBe(1);
    view.unmount();
    render(
      <WorkflowGuide
        workflow={w}
        platform={{ ...platform, load: async () => saved }}
        close={() => {}}
      />,
    );
    await screen.findByRole("img", { name: "Source for Collect sources" });
    expect(platform.generate).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Edit SOP" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove screenshot" }));
    await waitFor(() =>
      expect(platform.save.mock.calls.at(-1)![0].steps[0].includeImage).toBe(
        false,
      ),
    );
  });
  it("does not include a screenshot that fails to load", async () => {
    const w = structuredClone(workflow);
    delete w.stages[0].screenshot!.visualVerified;
    w.stages[1].screenshot = undefined;
    render(<WorkflowGuide workflow={w} platform={host()} close={() => {}} />);
    fireEvent.click(
      await screen.findByRole("button", { name: "Review screenshot" }),
    );
    fireEvent.error(
      screen.getByRole("img", { name: "Review source for Collect sources" }),
    );
    expect(
      screen.getByRole("button", { name: "Include screenshot" }),
    ).toBeDisabled();
    expect(
      screen.getByText("This screenshot could not be loaded."),
    ).toBeInTheDocument();
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
    fireEvent.click(await screen.findByRole("button", { name: "Open web editor", exact: true }));
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
    render(<GuideChat edit={edit} />);
    expect(screen.queryByRole("region", { name: "SOP assistant" })).not.toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Ask Screenpipe" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Ask Screenpipe" }), { target: { value: "Make it shorter" } });
    await waitFor(() => expect(screen.getByLabelText("Send message")).toBeEnabled());
    fireEvent.click(screen.getByLabelText("Send message"));
    await waitFor(() => expect(edit).toHaveBeenCalled());
    expect(edit.mock.calls[0][2]).toBe("Make it shorter");
    fireEvent.click(screen.getByLabelText("Stop answer"));
    expect(signal?.aborted).toBe(true);
  });
  it("applies a chat edit to the SOP and saves it", async () => {
    const save = vi.fn();
    const edit = vi.fn(async (draft: Guide) => ({ ...draft, title: "Shorter research SOP" }));
    render(<GuideChat edit={edit} save={save} previousFeedback />);
    fireEvent.click(await screen.findByRole("button", { name: "Ask Screenpipe" }));
    fireEvent.change(await screen.findByRole("textbox", { name: "Ask Screenpipe" }), { target: { value: "Shorten the title" } });
    await waitFor(() => expect(screen.getByLabelText("Send message")).toBeEnabled());
    fireEvent.click(screen.getByLabelText("Send message"));
    expect(await screen.findByRole("heading", { name: "Shorter research SOP" })).toBeInTheDocument();
    await waitFor(() => expect(save).toHaveBeenCalledWith(expect.objectContaining({ title: "Shorter research SOP" })));
    fireEvent.click(screen.getByLabelText("Minimize chat"));
    fireEvent.click(screen.getByRole("button", { name: "Ask Screenpipe" }));
    expect(screen.getAllByText("Shorten the title").length).toBeGreaterThan(0);
  });

});
