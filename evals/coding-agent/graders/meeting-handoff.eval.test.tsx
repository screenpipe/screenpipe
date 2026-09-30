// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import React from 'react';
import { beforeEach, afterEach, describe, test, expect, vi } from 'vitest';
import { render, screen, act, cleanup } from '@testing-library/react';
import { NoteView } from '@/components/meeting-notes/note-view';

const ports = vi.hoisted(() => ({
  observers: new Set<any>(), status: 'running', note: null as string | null,
  readStatus: 200, calls: [] as string[], unexpected: [] as string[],
  saved: vi.fn(), settings: { aiPresets: [], languages: ['english'], user: null },
  toast: vi.fn(), updateSettings: vi.fn(),
}));
vi.mock('@/lib/api', () => ({ localFetch: async (path: string, options?: any) => {
  ports.calls.push(`${options?.method || 'GET'} ${path}`);
  if (path === '/meetings/42' && options?.method === 'PUT') {
    const body = JSON.parse(options.body);
    if (body.note !== ports.note || body.title !== 'Synthetic meeting') {
      ports.unexpected.push('unexpected saved note');
    }
    return {ok: true};
  }
  if (options?.method && options.method !== 'GET') {
    ports.unexpected.push(`mutation ${path}`); throw new Error(`unexpected mutation ${path}`);
  }
  if (path.includes('/summary-status?')) return {ok: true, json: async () => ({
    state: ports.status, auto_summary_enabled: true, execution_id: 91,
    execution_status: ports.status === 'running' ? 'running' : 'completed',
  })};
  if (path === '/meetings/42') return {ok: ports.readStatus === 200, status: ports.readStatus,
    json: async () => meeting(ports.note)};
  if (path.endsWith('/transcript')) return {ok: true, json: async () => []};
  if (path === '/health') return {ok: true, json: async () => ({})};
  if (path === '/pipes/meeting-summary') return {ok: true, json: async () => ({data:{config:{preset:[]}}})};
  ports.unexpected.push(path); throw new Error(`unexpected path ${path}`);
}}));
vi.mock('@/lib/hooks/use-settings', () => ({ useSettings: () => ({settings: ports.settings, updateSettings: ports.updateSettings}) }));
vi.mock('@/lib/hooks/use-managed-policy', () => ({useManagedPolicy: () => ({isManagedDeployment: false, policy:{aiPresetPolicy:{}}})}));
vi.mock('@/lib/acp-rollout', async (original) => ({...await original<any>(), useAcpRolloutEnabled: () => false}));
vi.mock('@/lib/hooks/use-usage-status', () => ({useUsageStatus: () => null, hostedAiAllowanceForModel: () => null}));
vi.mock('@/components/ui/use-toast', () => ({useToast: () => ({toast: ports.toast})}));
vi.mock('@/lib/utils/tauri', () => ({commands: new Proxy({}, {get: () => () => {throw new Error('native command forbidden')}})}));
vi.mock('@tauri-apps/api/event', () => ({listen: async () => () => {}}));
vi.mock('@tauri-apps/api/webview', () => ({getCurrentWebview: () => ({onDragDropEvent: async () => () => {}})}));
vi.mock('@tauri-apps/plugin-shell', () => ({open: () => {throw new Error('external navigation forbidden')}}));
vi.mock('@tauri-apps/plugin-dialog', () => ({save: () => {throw new Error('native dialog forbidden')}}));
vi.mock('@tauri-apps/plugin-fs', () => ({readFile: () => {throw new Error('native filesystem forbidden')}}));
vi.mock('posthog-js', () => ({default: {capture: vi.fn()}}));
vi.mock('@/lib/analytics/qualified-value', () => ({qualifiedValue: {meetingNoteOpened: vi.fn()}}));
vi.mock('@/lib/logging/browser-log', () => ({writeBrowserLogNow: vi.fn()}));
vi.mock('@/lib/events/tauri-events', () => ({listenTyped: async () => () => {}, TAURI_EVENTS:{}}));
vi.mock('@/lib/events/bus', () => ({mountAgentEventBus: vi.fn(), registerObserver: (fn: any) => {
  ports.observers.add(fn); return () => ports.observers.delete(fn);
}}));
vi.mock('@/lib/utils/meeting-context', () => ({fetchMeetingContext: async () => null,
 fetchMeetingAudio: async () => [], renderMeetingTranscript: () => ''}));
vi.mock('@/components/meeting-notes/use-meeting-chat', () => ({useMeetingChat: () => ({inFlight:false, turns:[]})}));
vi.mock('@/components/meeting-notes/use-meeting-one-tap-send', () => ({useMeetingOneTapSend: () => ({label:null,suggestions:[]})}));
vi.mock('@/components/meeting-notes/attendees-pill', () => ({AttendeesPill: () => null}));
vi.mock('@/components/meeting-notes/receipts', () => ({Receipts: () => null}));
vi.mock('@/components/meeting-notes/replay-strip', () => ({ReplayStrip: () => null}));
vi.mock('@/components/meeting-notes/listening-sticks', () => ({ListeningSticks: () => null}));
vi.mock('@/components/meeting-notes/transcript-panel', () => ({TranscriptPanel: () => null}));
vi.mock('@/components/meeting-notes/meeting-share-menu', () => ({MeetingShareMenu: () => null}));
vi.mock('@/components/meeting-notes/meeting-chat-panel', () => ({MeetingChatPanel: () => null}));
vi.mock('@/components/meeting-notes/meeting-summary-transition', () => ({MeetingSummaryTransition: () => null}));
vi.mock('@/components/meeting-notes/note-editor', () => ({NoteEditor: React.forwardRef(() => null)}));
vi.mock('@/components/connected-share-dialog', () => ({ConnectedShareDialog: () => null}));

const fresh = '## Summary\nFresh synthetic summary.';
const old = '## Summary\nEarlier synthetic summary.';
function meeting(note: string | null) { return {id:42, meeting_start:'2026-09-02T10:00:00Z',
 meeting_end:'2026-09-02T10:30:00Z', meeting_app:'zoom', title:'Synthetic meeting',
 attendees:null,note,detection_source:'auto',created_at:'2026-09-02T10:00:00Z'}; }
async function mount(note: string | null = null) {
 function Host() {
  const [value,setValue] = React.useState(meeting(note));
  return <NoteView meeting={value as any} isLive={false} stopping={false} resuming={false}
   initialWorkspaceTab="summary" onBack={() => {}} onStop={async () => {}} onResume={async () => {}}
   onDeleted={() => {}} onSaved={(updated: any) => {ports.saved(updated);setValue(updated)}} />;
 }
 let view: any;
 await act(async () => {view = render(<Host/>)}); return view;
}
async function tick(ms = 2000) { await act(async () => {await vi.advanceTimersByTimeAsync(ms)}); }
async function emit(text = fresh, sessionId = 'pipe:meeting-summary:91', executionId = 91) {
 await act(async () => { for (const fn of ports.observers) fn({source:'pipe',sessionId,executionId,
  event:{type:'message_update',assistantMessageEvent:{type:'text_delta',delta:text}}}); });
}
beforeEach(() => {
 vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-02T11:00:00Z'));
 ports.observers.clear();ports.status='running';ports.note=null;ports.readStatus=200;
 ports.calls=[];ports.unexpected=[];ports.saved.mockClear();localStorage.clear();
 Object.defineProperty(window,'matchMedia',{writable:true,value:() => ({matches:true,addListener(){},removeListener(){},addEventListener(){},removeEventListener(){}})});
 globalThis.ResizeObserver = class {observe(){} unobserve(){} disconnect(){}} as any;
 HTMLElement.prototype.scrollIntoView = () => {};
});
afterEach(() => { cleanup();vi.useRealTimers();expect(ports.unexpected).toEqual([]); });

describe('completed meeting summary handoff', () => {
 test.each([null,old])('retains stream while waiting for a fresh save from %s', async (initial) => {
  ports.note=initial;await mount(initial);await emit();
  expect(screen.getByText('Fresh synthetic summary.')).toBeTruthy();
  ports.status='ready';await tick();
  expect(screen.getByText('Fresh synthetic summary.')).toBeTruthy();
  expect(ports.saved).not.toHaveBeenCalled();
  ports.note=fresh;await tick(10000);
  expect(ports.saved).toHaveBeenCalled();
  expect(ports.saved.mock.calls.every(([value]) => value.note === fresh)).toBe(true);
  expect(screen.getByText('Fresh synthetic summary.')).toBeTruthy();
  const reads=ports.calls.filter(c => c === 'GET /meetings/42').length;
  await tick(10000);expect(ports.calls.filter(c => c === 'GET /meetings/42')).toHaveLength(reads);
 });
 test.each([null,old])('does not report a stale completed note as saved from %s', async (initial) => {
  ports.note=initial;await mount(initial);ports.status='ready';await tick();
  expect(ports.saved).not.toHaveBeenCalled();ports.note=fresh;await tick(10000);
  expect(ports.saved).toHaveBeenCalled();
  expect(ports.saved.mock.calls.every(([value]) => value.note === fresh)).toBe(true);
 });
 test('does not save while status remains running', async () => {
  ports.note=fresh;await mount();await emit();await tick(10000);
  expect(ports.saved).not.toHaveBeenCalled();
  expect(ports.calls.filter(c => c === 'GET /meetings/42')).toHaveLength(0);
 });
 test('retries a failed completed-note read and then delivers the saved summary', async () => {
  await mount();await emit();ports.status='ready';ports.readStatus=503;await tick();
  expect(ports.saved).not.toHaveBeenCalled();ports.readStatus=200;ports.note=fresh;
  await tick(10000);expect(ports.saved).toHaveBeenCalled();
  expect(ports.saved.mock.calls.every(([value]) => value.note === fresh)).toBe(true);
 });
 test('accepts an already saved summary on initial completed status once', async () => {
  ports.status='ready';ports.note=old;await mount(old);
  expect(ports.saved).toHaveBeenCalledTimes(1);
  expect(screen.getByText('Earlier synthetic summary.')).toBeTruthy();
  await tick(20000);expect(ports.saved).toHaveBeenCalledTimes(1);
 });
 test('ignores another pipe and another execution while retaining the matching stream', async () => {
  await mount();await emit('Wrong pipe','pipe:other:91',91);
  await emit('Wrong execution','pipe:meeting-summary:92',92);
  expect(screen.queryByText(/Wrong pipe|Wrong execution/)).toBeNull();await emit();
  expect(screen.getByText('Fresh synthetic summary.')).toBeTruthy();
 });
 test('unmount removes stream subscription and stops polling', async () => {
  const view = await mount();view.unmount();const count=ports.calls.length;
  await tick(30000);expect(ports.calls).toHaveLength(count);
  expect(ports.observers.size).toBe(0);expect(ports.saved).not.toHaveBeenCalled();
 });
});
