// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
// @vitest-environment jsdom
import React from 'react';
import {createRoot} from 'react-dom/client';
import {act} from 'react-dom/test-utils';
import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import {useChatInspector} from '@/lib/hooks/use-chat-inspector';
const port=vi.hoisted(()=>({fetch:vi.fn()}));
vi.mock('@/lib/api',()=>({localFetch:(...args:any[])=>port.fetch(...args)}));
let root:any,host:any,value:any,rows:any[];
const source='pipe:synthetic:7';const output='/synthetic/run7/report.md';
const row=(s=source,path=output)=>({registered:true,id:7,source:s,source_type:'pipe-run',title:'Synthetic report',kind:'markdown',path,original_path:'/synthetic/declared/report.md',size_bytes:100,preview:null,saf_kind:null,artifact_id:null,saf_version:null,modified_at:'2026-08-17T00:00:00Z',created_at:'2026-08-17T00:00:00Z'});
const messages=[{contentBlocks:[{type:'tool',toolCall:{toolName:'save_artifact',args:{title:'Synthetic explicit report'},result:'Saved "report" to Artifacts (/synthetic/declared/report.md)',isRunning:false}}]}];
function Probe({s,m}:any){value=(useChatInspector as any)(m,s);return null;}
async function render(s:any=source,m:any=[]){await act(async()=>root.render(React.createElement(Probe,{s,m})));}
beforeEach(()=>{(globalThis as any).IS_REACT_ACT_ENVIRONMENT=true;vi.useFakeTimers();host=document.createElement('div');document.body.append(host);root=createRoot(host);rows=[row()];port.fetch.mockReset().mockImplementation(async()=>({ok:true,text:async()=>JSON.stringify({data:rows,pagination:{total:rows.length},sources:[source]})}));});
afterEach(async()=>{await act(async()=>root.unmount());host.remove();vi.clearAllTimers();vi.useRealTimers();});
it('registered active-run output appears without an explicit tool call',async()=>{await render();expect(value.outputs.map((x:any)=>x.path)).toEqual([output]);expect(port.fetch.mock.calls.length).toBeGreaterThan(0);for(const [url] of port.fetch.mock.calls)expect(new URL(url,'http://synthetic.invalid').searchParams.get('source')).toBe(source);});
it('another run is excluded while active output remains',async()=>{rows=[row('pipe:synthetic:8','/synthetic/other/report.md'),row()];await render();expect(value.outputs.map((x:any)=>x.path)).toEqual([output]);});
it('explicit output is preserved and registered original-path duplicate suppressed',async()=>{await render(source,messages);expect(value.outputs.map((x:any)=>x.path)).toEqual(['/synthetic/declared/report.md']);});
it('ordinary chat preserves explicit outputs without artifact API reads',async()=>{await render(null,messages);expect(value.outputs.map((x:any)=>x.path)).toEqual(['/synthetic/declared/report.md']);expect(port.fetch).not.toHaveBeenCalled();});
it('switching away from pipe context clears registered outputs',async()=>{await render();await render(null);expect(value.outputs).toEqual([]);});
it('transient artifact failure can recover when transcript grows',async()=>{port.fetch.mockResolvedValue({ok:false,status:503});await render();expect(value.outputs).toEqual([]);port.fetch.mockImplementation(async()=>({ok:true,text:async()=>JSON.stringify({data:[row()],pagination:{total:1},sources:[source]})}));await render(source,[{contentBlocks:[]}]);expect(value.outputs.map((x:any)=>x.path)).toEqual([output]);});
