// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { it, expect, vi, beforeEach } from 'vitest';
const mocks = vi.hoisted(() => ({ run: vi.fn(), mkdir: vi.fn(), write: vi.fn(), read: vi.fn(), copy: vi.fn(), save: vi.fn() }));
vi.mock('./agent-runner', () => ({ runWorkflowAgent: mocks.run }));
vi.mock('./assistant', () => ({ assistantProviderConfig: { provider: 'screenpipe-cloud', model: 'auto' } }));
vi.mock('@/lib/utils/tauri', () => ({ commands: { getScreenpipeBaseDir: async () => ({ status: 'ok', data: '/synthetic/workspace' }) } }));
vi.mock('@tauri-apps/plugin-fs', () => ({ mkdir: mocks.mkdir, writeTextFile: mocks.write, readFile: mocks.read, copyFile: mocks.copy }));
vi.mock('@tauri-apps/plugin-dialog', () => ({ save: mocks.save }));
import { guideVideo } from './guide-video';
import { fixtureWorkflowAnalysis } from '../../../../packages/workflows-ui/src/fixture-platform';
import type { WorkflowGuide } from '@screenpipe/workflows-ui';
const workflow = fixtureWorkflowAnalysis.analysis.workflows[0];
const guide: WorkflowGuide = { version: 1, workflowKey: workflow.id!, sourceRevision: workflow.revision ?? 0, title: 'Guide', summary: '', prerequisites: [], exceptions: [], completion: [], questions: [], steps: [{ title: 'Read', instruction: 'Read the brief.', narration: 'Open the brief.', sourceStage: 0, includeImage: true, expectedResult: '' }] };
beforeEach(() => {
  vi.clearAllMocks();
  mocks.read.mockResolvedValue(new Uint8Array([1,2,3]));
  URL.createObjectURL = vi.fn(() => 'blob:synthetic-video');
  URL.revokeObjectURL = vi.fn();
});
it('scopes the harness to the render tool and requires its completed receipt', async () => {
  mocks.run.mockResolvedValue('The video is ready');
  await expect(guideVideo.render(guide, workflow, false, new AbortController().signal, () => {})).rejects.toThrow('did not render');
  expect(mocks.read).not.toHaveBeenCalled();
});
it('keeps images and narration out of the agent prompt and waits for explicit MP4 export', async () => {
  const progress = vi.fn();
  mocks.run.mockImplementation(async options => {
    const jobId = options.prompt.match(/jobId ([a-f0-9-]{36})/)[1];
    options.onEvent({ type: 'tool_execution_update', toolName: 'render_guide_video', partialResult: { content: [{ text: 'Rendering scene 1 of 1' }] } });
    options.onEvent({ type: 'tool_execution_end', toolName: 'render_guide_video', result: { content: [{ text: JSON.stringify({ jobId, filename: 'guide.mp4' }) }] } });
    return 'Ready';
  });
  const result = await guideVideo.render(guide, workflow, false, new AbortController().signal, progress);
  expect(mocks.run.mock.calls[0][0].config.allowedTools).toEqual(['render_guide_video']);
  expect(mocks.run.mock.calls[0][0].prompt).not.toContain('Open the brief.');
  expect(JSON.parse(mocks.write.mock.calls[0][1])).toEqual([{ title: 'Read', narration: 'Open the brief.', image: null }]);
  expect(progress).toHaveBeenCalledWith('Rendering scene 1 of 1');
  expect(mocks.copy).not.toHaveBeenCalled();
  mocks.save.mockResolvedValue(null); expect(await result.export()).toBe(false);
  mocks.save.mockResolvedValue('/synthetic/export.mp4'); expect(await result.export()).toBe(true);
  expect(mocks.copy).toHaveBeenCalledWith(expect.stringContaining('/guide.mp4'), '/synthetic/export.mp4');
  result.dispose(); expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:synthetic-video');
});
