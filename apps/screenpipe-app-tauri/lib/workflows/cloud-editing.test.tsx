// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import React from "react";
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
      title="Orders"
      summary="Check orders"
      request={request}
      back={() => {}}
      onSaved={() => {}}
      onDenied={() => {}}
      {...extra}
    />,
  );
}
describe("cloud workflow editor", () => {
  it("saves the canonical revision and preserves fields outside the edited text", async () => {
    const request = api();
    view(request);
    fireEvent.change(await screen.findByLabelText("Step 1 instructions"), {
      target: { value: "Confirm reference and customer" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText("Saved · Version 4");
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
            detail: "Confirm reference and customer",
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
    fireEvent.change(await screen.findByLabelText("Step 1 instructions"), {
      target: { value: "Keep my draft" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText("Connection lost");
    expect(screen.getByLabelText("Step 1 instructions")).toHaveValue(
      "Keep my draft",
    );
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await screen.findByText("Saved · Version 4");
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
    expect(await screen.findByLabelText("Step 1 action")).toBeDisabled();
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
    expect(screen.queryByLabelText("Step 1 action")).toBeNull();
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
    view(api(), { drafts });
    expect(await screen.findByLabelText("Step 1 instructions")).toHaveValue(
      "Older draft",
    );
    expect(screen.getByRole("button", { name: "Save changes" })).toBeDisabled();
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
    fireEvent.change(await screen.findByLabelText("Step 1 action"), {
      target: { value: "Changed" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
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
  const input = await screen.findByLabelText('Message about this workflow'); await waitFor(() => expect(input).not.toBeDisabled());
  fireEvent.change(input, { target: { value: 'Clarify the order' } }); fireEvent.click(screen.getByRole('button', { name: 'Send' }));
  await screen.findByText('Lost enqueue response'); fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
  await screen.findByText('Recovered response'); await waitFor(() => expect(chat.messages.filter((message: any) => message.role === 'assistant')).toHaveLength(1));
  const calls = request.mock.calls.filter(([url, init]) => String(url).includes('/chat/turn') && init?.method === 'POST');
  expect(calls[0][1]?.body).toEqual(calls[1][1]?.body); expect(chat.messages.filter((message: any) => message.role === 'user')).toHaveLength(1);
});
