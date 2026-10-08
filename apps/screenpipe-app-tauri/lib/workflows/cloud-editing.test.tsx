// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import React from "react";
import { cloudWorkflowMap } from "./cloud-presentation";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  CloudWorkflowEditor,
  CloudWorkflowChat,
  projectCloudTurn,
  type CloudProcedure,
} from "@screenpipe/workflows-ui";
const identity = {
  license_id: "workspace",
  artifact_id: "orders",
  workflow_id: "a".repeat(64),
};
const procedure: CloudProcedure = {
  revision: 3,
  source_version: 2,
  actor_scope: "org_member_v1_" + "b".repeat(64),
  can_edit: true,
  review: { frozen: false, status: "unreviewed" },
  document: {
    steps: [
      {
        id: "step-1",
        action: "Check order",
        detail: "Check the reference",
        kind: "action",
        app: "Orders",
        expected_result: "Matched",
        caveat: "Retain this caveat",
        required_access: "Orders access",
        escalation: "Ask manager",
        response_template: "Confirmed",
      },
    ],
  },
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status });
function api() {
  return vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    if (String(url).includes("/procedure"))
      return init?.method === "PUT"
        ? json({ revision: 4, review: procedure.review })
        : json(procedure);
    return json({ conversation: null });
  });
}
function view(request = api(), extra = {}) {
  return render(
    <CloudWorkflowEditor
      identity={identity}
      workflow={cloudWorkflowMap({ id: identity.workflow_id, title: "Orders", summary: "Check orders", steps: [], version: 2, updatedAt: "" }, 0)}
      request={request}
      back={() => {}}
      onSaved={() => {}}
      onDenied={() => {}}
      {...extra}
    />,
  );
}
describe("cloud workflow editor", () => {
  it.each([
    { can_edit: false, review: procedure.review, message: "View only. Your admin controls workflow editing." },
    { can_edit: true, review: { frozen: true, status: "approved" }, message: "Approved workflow. Ask an admin to reopen it before editing." },
  ])("keeps the document view without writes when policy is $message", async ({ can_edit, review, message }) => {
    const request = vi.fn<typeof fetch>().mockResolvedValue(json({ ...procedure, can_edit, review }));
    view(request);
    expect(await screen.findByText(message)).toBeVisible();
    expect(screen.getByRole('region', { name: 'Workflow document' })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Check order' })).toBeVisible();
    expect(screen.getByText('Matched')).toBeVisible();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Open chat' })).not.toBeInTheDocument();
    expect(request.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(true);
  });

  it("saves the canonical revision and preserves fields outside the edited text", async () => {
    const request = api();
    view(request);
    fireEvent.change(await screen.findByLabelText("Step 1 title"), {
      target: { value: "Confirm reference and customer" },
    });

    await screen.findByText("Saved");
    const write = request.mock.calls.find(
      ([, init]) => init?.method === "PUT",
    )!;
    expect(JSON.parse(String(write[1]?.body))).toMatchObject({
      ...identity,
      expected_revision: 3,
      source_version: 2,
      document: {
        steps: [
          {
            id: "step-1",
            action: "Confirm reference and customer",
            caveat: "Retain this caveat",
            escalation: "Ask manager",
          },
        ],
      },
    });
  });
  it("retains a failed save and retries exactly the same revision", async () => {
    const request = api();
    let writes = 0;
    request.mockImplementation(async (url, init) =>
      String(url).includes("/procedure")
        ? init?.method === "PUT"
          ? ++writes === 1
            ? json({ error: "Connection lost" }, 503)
            : json({ revision: 4, review: procedure.review })
          : json(procedure)
        : json({ conversation: null }),
    );
    view(request);
    fireEvent.change(await screen.findByLabelText("Step 1 title"), {
      target: { value: "Keep my draft" },
    });

    await screen.findByText("Connection lost");
    expect(screen.getByLabelText("Step 1 title")).toHaveValue(
      "Keep my draft",
    );
    fireEvent.click(screen.getByRole("button", { name: "Retry save" }));

    await screen.findByText("Saved");
    const bodies = request.mock.calls
      .filter(([, init]) => init?.method === "PUT")
      .map(([, init]) => init?.body);
    expect(bodies[0]).toEqual(bodies[1]);
  });
  it("withholds editing and chat under read-only policy", async () => {
    const request = api().mockResolvedValue(
      json({ ...procedure, can_edit: false }),
    );
    view(request);
    await screen.findByText("View only. Your admin controls workflow editing.");
    expect(screen.queryByLabelText("Step 1 title")).toBeNull();
    expect(screen.queryByRole("heading", { name: "Workflow chat" })).toBeNull();
    expect(request).toHaveBeenCalledTimes(1);
  });
  it("never overwrites a recoverable draft when the disk read fails", async () => {
    const drafts = {
      load: vi.fn().mockRejectedValue(new Error("Unreadable draft")),
      save: vi.fn(),
    };
    view(api(), { drafts });
    await screen.findByText("Unreadable draft");
    expect(drafts.save).not.toHaveBeenCalled();
    expect(screen.queryByLabelText("Step 1 title")).toBeNull();
  });
  it("keeps a stale disk draft and prevents saving over a newer cloud revision", async () => {
    const drafts = {
      load: vi
        .fn()
        .mockResolvedValue({
          ...procedure,
          revision: 1,
          document: {
            steps: [{ ...procedure.document.steps[0], detail: "Older draft" }],
          },
        }),
      save: vi.fn().mockResolvedValue(undefined),
    };
    const request = api();
    view(request, { drafts });
    expect(await screen.findByLabelText("Step 1 description")).toHaveTextContent(
      "Older draft",
    );
    await new Promise(resolve => setTimeout(resolve, 800));
    expect(screen.getByText(/This workflow changed since your draft/)).toBeInTheDocument();
    expect(request.mock.calls.some(([, init]) => init?.method === "PUT")).toBe(false);
    drafts.load.mockResolvedValue(null);
    fireEvent.click(screen.getByRole("button", { name: "Discard draft and reload" }));
    await waitFor(() => expect(screen.getByLabelText("Step 1 description")).toHaveTextContent("Check the reference"));
    expect(drafts.save).toHaveBeenCalledWith(expect.any(String), null);
  });
  it("retains step identities and fields when restoring a reordered disk draft", async () => {
    const second = { ...procedure.document.steps[0], id: "step-2", action: "Send order", caveat: "Second caveat" };
    const saved = { ...procedure, document: { steps: [procedure.document.steps[0], second] } };
    const recovered = { ...saved, document: { steps: [second, procedure.document.steps[0]] } };
    const request = api().mockImplementation(async (url, init) => String(url).includes("/procedure")
      ? init?.method === "PUT" ? json({ revision: 4, review: procedure.review }) : json(saved)
      : json({ conversation: null }));
    view(request, { drafts: { load: async () => recovered, save: async () => {} } });
    expect(await screen.findByLabelText("Step 1 title")).toHaveValue("Send order");
    await screen.findByText("Saved");
    const write = request.mock.calls.find(([, init]) => init?.method === "PUT")!;
    expect(JSON.parse(String(write[1]?.body)).document.steps).toEqual(recovered.document.steps);
  });
  it("drops protected content after a save is denied", async () => {
    const request = api();
    const denied = vi.fn();
    request.mockImplementation(async (url, init) =>
      String(url).includes("/procedure")
        ? init?.method === "PUT"
          ? json({ error: "Access revoked" }, 403)
          : json(procedure)
        : json({ conversation: null }),
    );
    view(request, { onDenied: denied });
    fireEvent.change(await screen.findByLabelText("Step 1 title"), {
      target: { value: "Changed" },
    });

    await waitFor(() => expect(denied).toHaveBeenCalled());
    expect(screen.queryByDisplayValue("Changed")).toBeNull();
  });
});
it("replaces streamed text snapshots and retains a server-confirmed edit proposal", () => {
  const proposal = {
    document: procedure.document,
    expected_revision: 3,
    source_version: 2,
    summary: "Clarify",
  };
  const result = projectCloudTurn(
    [
      { type: "text", id: "a", text: "First" },
      { type: "text", id: "a", text: "Finished" },
      {
        type: "tool_result",
        id: "edit",
        name: "propose_workflow_edit",
        output: { proposal },
      },
    ],
    "turn",
  );
  expect(result.parts).toEqual([
    { type: "text", text: "Finished" },
    { type: "workflow-proposal", proposal },
  ]);
});
it("reconnects to a durable turn and waits for explicit review before applying", async () => {
  const turn = "33333333-3333-4333-8333-333333333333";
  const proposal = { document: procedure.document, expected_revision: 3, source_version: 2, summary: "Clarify order check" };
  let chat = { id: "chat", revision: 0, composer: "", messages: [{ id: "user", role: "user", parts: [{ type: "text", text: "Clarify" }] }] };
  const request = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    if (String(url).includes('/chat/turn')) return json({ status: 'completed', cursor: 2, hasMore: false, events: [{ type: 'text', id: 'reply', text: 'Review the change.' }, { type: 'tool_result', id: 'edit', name: 'propose_workflow_edit', output: { proposal } }] });
    if (String(url).includes('/procedure')) return json({ revision: 4 });
    if (init?.method === 'PUT') { const body = JSON.parse(String(init.body)); chat = { ...chat, messages: body.messages, revision: chat.revision + 1 }; return json({ conversation: chat }); }
    return json({ conversation: { ...chat, pending_turn: { turn_id: turn, messages: [{ role: 'user', text: 'Clarify' }] } } });
  });
  const applied = vi.fn(); render(<CloudWorkflowChat identity={identity} request={request} onApplied={applied} onDenied={() => {}}/>);
  fireEvent.click(await screen.findByRole('button', { name: 'Ask Screenpipe' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Review changes: Clarify order check' }));
  expect(request.mock.calls.some(([url]) => String(url).includes('/procedure'))).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Apply changes' })); await waitFor(() => expect(applied).toHaveBeenCalledTimes(1));
  expect(request.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  expect(chat.messages.filter(message => message.role === 'assistant')).toHaveLength(1);
});
it("retries an ambiguous enqueue with the same turn and no duplicate user message", async () => {
  let chat: any = null; let enqueues = 0;
  const request = vi.fn<typeof fetch>().mockImplementation(async (url, init) => {
    if (String(url).includes('/chat/turn')) {
      if (init?.method === 'POST') { if (!enqueues++) throw new Error('Lost enqueue response'); return json({}); }
      return json({ status: 'completed', cursor: 1, hasMore: false, events: [{ type: 'text', id: 'reply', text: 'Recovered response' }] });
    }
    if (init?.method === 'POST') chat = { id: 'chat', revision: 0, messages: [], composer: '' };
    if (init?.method === 'PUT') { const body = JSON.parse(String(init.body)); chat = { ...chat, revision: chat.revision + 1, messages: body.messages, composer: body.composer }; }
    return json({ conversation: chat });
  });
  render(<CloudWorkflowChat identity={identity} request={request} onApplied={() => {}} onDenied={() => {}}/>);
  fireEvent.click(await screen.findByRole('button', { name: 'Ask Screenpipe' }));
  const input = await screen.findByRole('textbox', { name: 'Ask Screenpipe' }); await waitFor(() => expect(input).not.toBeDisabled());
  fireEvent.change(input, { target: { value: 'Clarify the order' } }); fireEvent.click(screen.getByRole('button', { name: 'Send message' }));
  await screen.findByText('Lost enqueue response'); fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
  await screen.findByText('Recovered response'); await waitFor(() => expect(chat.messages.filter((message: any) => message.role === 'assistant')).toHaveLength(1));
  const calls = request.mock.calls.filter(([url, init]) => String(url).includes('/chat/turn') && init?.method === 'POST');
  expect(calls[0][1]?.body).toEqual(calls[1][1]?.body); expect(chat.messages.filter((message: any) => message.role === 'user')).toHaveLength(1);
});
