// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { beforeEach, expect, it, vi } from "vitest";
vi.mock("@/lib/api", () => ({ localFetch: vi.fn() }));
import { localFetch } from "@/lib/api";
import { stopLocalWorkflowProcessing } from "./cloud-processing";
const fetchMock = vi.mocked(localFetch);
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
let tasks: Map<string, { enabled: boolean; running: boolean }>;
beforeEach(() => {
  tasks = new Map([['workflow-discover', { enabled: true, running: true }], ['workflow-discovery', { enabled: true, running: true }], ['daily-recap', { enabled: true, running: true }]]);
  fetchMock.mockReset().mockImplementation(async (path, init) => {
    if (path === '/pipes') return response({ data: [...tasks].map(([name, task]) => ({ config: { name, enabled: task.enabled }, is_running: task.running })) });
    if (path === '/workflows/workspace') return response({});
    const [, , name, action] = String(path).split('/'); const task = tasks.get(name)!;
    if (action === 'enable') task.enabled = JSON.parse(String(init?.body)).enabled;
    if (action === 'stop') task.running = false;
    return response({ data: { config: { name, enabled: task.enabled }, is_running: task.running } });
  });
});
it("stops and disables current and legacy tasks without touching other tasks or capture", async () => {
  await stopLocalWorkflowProcessing();
  expect(tasks.get('workflow-discover')).toEqual({ enabled: false, running: false }); expect(tasks.get('workflow-discovery')).toEqual({ enabled: false, running: false });
  expect(tasks.get('daily-recap')).toEqual({ enabled: true, running: true });
  expect(fetchMock.mock.calls.every(([path]) => path === '/pipes' || String(path).startsWith('/pipes/workflow-') || path === '/workflows/workspace')).toBe(true);
  expect(fetchMock.mock.calls.some(([path]) => String(path).includes('/install'))).toBe(false);
});
it("does not claim off while a stopped job is still running", async () => {
  const original = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation((path, init) => String(path).endsWith('/stop') ? Promise.resolve(response({ status: 'stop_pending' })) : original(path, init));
  await expect(stopLocalWorkflowProcessing()).rejects.toThrow("Could not confirm");
});
it("attempts all stops on partial failure and allows retry", async () => {
  const original = fetchMock.getMockImplementation()!;
  fetchMock.mockImplementation((path, init) => path === '/pipes/workflow-discover/enable' ? Promise.resolve(response({ error: 'offline' }, 503)) : original(path, init));
  await expect(stopLocalWorkflowProcessing()).rejects.toThrow("Could not confirm"); expect(tasks.get('workflow-discovery')).toEqual({ enabled: false, running: false });
  fetchMock.mockImplementation(original); await stopLocalWorkflowProcessing();
});
it("does not install missing tasks and refuses an unreadable list", async () => {
  tasks.clear(); await stopLocalWorkflowProcessing(); expect(fetchMock).toHaveBeenCalledTimes(1);
  fetchMock.mockResolvedValue(response({})); await expect(stopLocalWorkflowProcessing()).rejects.toThrow("Could not check");
});

it("does not write after leaving cloud mode", async () => {
  const controller = new AbortController(); controller.abort();
  await expect(stopLocalWorkflowProcessing(controller.signal)).rejects.toThrow();
  expect(fetchMock).not.toHaveBeenCalled();
});
it("only reads when all local workflow tasks are already stopped", async () => {
  for (const [name, task] of tasks) if (name.startsWith('workflow-')) { task.enabled = false; task.running = false; }
  await stopLocalWorkflowProcessing(); expect(fetchMock).toHaveBeenCalledTimes(1);
});
