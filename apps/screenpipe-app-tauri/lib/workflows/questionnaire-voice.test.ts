// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterEach, expect, it, vi } from 'vitest';
const stubs = vi.hoisted(() => ({ token: vi.fn(async () => 'fixture-token'), mode: vi.fn(async () => 'intelligent'), fetch: vi.fn(), run: vi.fn() }));
vi.mock('@/lib/utils/tauri', () => ({ commands: { getCloudToken: stubs.token } }));
vi.mock('@/lib/ai-gateway-url', () => ({ fetchAiGateway: stubs.fetch }));
vi.mock('./model-choice', () => ({ workflowModelPreference: { load: stubs.mode } }));
vi.mock('./agent-runner', () => ({ runWorkflowAgent: stubs.run }));
vi.mock('./assistant', () => ({ assistantProviderConfig: {} }));
import { desktopQuestionnaireVoice } from './questionnaire-voice';
import { parseVoiceAnswers } from '../../../../packages/workflows-ui/src/questionnaire-voice';
afterEach(() => vi.clearAllMocks());
it('uses the validated Cloudflare gateway and account token, never an admin or provider key', async () => {
 stubs.fetch.mockResolvedValue(Response.json({ sdp: 'v=0', call_token: 'opaque', expires_at: 1 }));
 await desktopQuestionnaireVoice.connect({ sdp: 'v=0', title: 'Fixture', questions: ['Who?'] }, new AbortController().signal);
 expect(stubs.fetch).toHaveBeenCalledWith('/workflow-voice', expect.objectContaining({ method: 'POST', headers: { Authorization: 'Bearer fixture-token', 'Content-Type': 'application/json' } }));
 await desktopQuestionnaireVoice.disconnect('opaque');
 expect(stubs.fetch).toHaveBeenLastCalledWith('/workflow-voice', expect.objectContaining({ method: 'DELETE', body: JSON.stringify({ call_token: 'opaque' }) }));
});
it('fails closed before sending voice in private mode or when signed out', async () => {
 stubs.mode.mockResolvedValueOnce('private');
 await expect(desktopQuestionnaireVoice.connect({ sdp: 'v=0', title: '', questions: [] }, new AbortController().signal)).rejects.toThrow('Switch to Intelligent');
 expect(stubs.fetch).not.toHaveBeenCalled();
 stubs.token.mockResolvedValueOnce('');
 await expect(desktopQuestionnaireVoice.connect({ sdp: 'v=0', title: '', questions: [] }, new AbortController().signal)).rejects.toThrow('Sign in');
});
it('uses the existing agent with no tools and only accepts known unlocked grounded answers', async () => {
 const raw = JSON.stringify({ answers: [{ question: 'Who?', answer: 'Lead', quote: 'The lead' }, { question: 'Locked?', answer: 'Rewrite', quote: 'The lead' }, { question: 'Unknown?', answer: 'X', quote: 'The lead' }, { question: 'Where?', answer: 'Invented', quote: 'Missing quote' }] });
 stubs.run.mockResolvedValue(raw);
 const result = await desktopQuestionnaireVoice.fill({ questions: ['Who?', 'Locked?', 'Where?'], locked: ['Locked?'], transcript: 'The lead reviews it.' }, new AbortController().signal);
 expect(result).toEqual([{ question: 'Who?', answer: 'Lead', quote: 'The lead' }]);
 expect(stubs.run).toHaveBeenCalledWith(expect.objectContaining({ config: expect.objectContaining({ allowedTools: [] }) }));
 expect(() => parseVoiceAnswers('{}', [], '', [])).toThrow();
});
