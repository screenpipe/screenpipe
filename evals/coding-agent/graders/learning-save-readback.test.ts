// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterEach, expect, test } from 'bun:test';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import learning from '../../../crates/screenpipe-core/assets/extensions/skill-learning';
const proposal = { name:'screenpipe-learned-brief-check', description:'Check a brief before saving', instructions:'For a recurring brief, verify the source and unresolved action. Stop when the source is ambiguous. Confirm each retained action has support.', checks:['Intended use: verify a supported action.', 'Counterexample: leave an unrelated task alone.', 'Privacy: keep personal identities out of the method.'] };
const originalFetch = globalThis.fetch, roots: string[] = [];
afterEach(async()=>{globalThis.fetch=originalFetch;for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function harness(options: any = {}) {
 const root=await mkdtemp(join(tmpdir(),'eval-learning-readback-'));roots.push(root);
 await writeFile(join(root,'.screenpipe-learning-config.json'),JSON.stringify({port:3130}));
 await writeFile(join(root,'.screenpipe-permissions.json'),JSON.stringify({pipe_token:'synthetic-eval-token'}));
 const previous=options.patch?{...proposal,key:proposal.name,origin:'agent',sha256:'old-sha',instructions:'Previous short method.'}:null;
 const initial=options.state??{used:[],owned:previous?{[proposal.name]:'old-sha'}:{},changes:0};
 await mkdir(join(root,'output'));await writeFile(join(root,'output/learning-state.json'),JSON.stringify(initial));
 const hooks=new Map(),tools=new Map(),writes:any[]=[];let stored:any=previous;
 globalThis.fetch=(async(url:any,init:any)=>{
  expect(new URL(String(url)).origin).toBe('http://127.0.0.1:3130');
  const path=new URL(String(url)).pathname, body=init.body?JSON.parse(init.body):{};
  if(path==='/search')return Response.json({data:[{content:{text:'A synthetic brief omitted a supported action on one occasion.',timestamp:'2026-01-01T00:00:00Z'}},{content:{text:'Another synthetic brief needed its source checked on a separate occasion.',timestamp:'2026-01-02T00:00:00Z'}}]});
  expect(path).toBe('/agent/skills/manage');
  if(body.action==='list')return Response.json({skills:previous?[previous]:[]});
  if(body.action==='read')return Response.json({skill:stored});
  expect(['create','patch']).toContain(body.action);writes.push(body);
  if(options.writeFailure)return Response.json({error:'synthetic unavailable'},{status:503});
  const saved={...body,name:body.name,key:body.name,origin:'agent',description:body.description.trim(),instructions:body.instructions.trim(),sha256:'new-sha',...options.saved};
  stored={...saved,...options.readback};return Response.json({skill:saved});
 }) as any;
 learning({on:(n:string,fn:any)=>hooks.set(n,fn),registerTool:(t:any)=>tools.set(t.name,t),setActiveTools:()=>{}} as any);
 await hooks.get('session_start')({}, {cwd:root});
 const call=async(n:string,input:any={})=>{const r=await tools.get(n).execute('synthetic-call',input);return {...JSON.parse(r.content[0].text),isError:r.isError};};
 const prepare=async()=>{await call('learning_inventory');if(previous)await call('learning_inventory',{name:proposal.name});return (await call('learning_context',{source:'activity'})).items.map((x:any)=>x.ref);};
 const state=async()=>JSON.parse(await readFile(join(root,'output/learning-state.json'),'utf8'));
 return {root,writes,call,prepare,state,initial};
}
async function uncertain(options:any){
 const h=await harness(options),evidence=await h.prepare(),input={...proposal,evidence};
 const r=await h.call('learning_save',input);expect(r.isError).toBe(true);expect(r.saved).toBeUndefined();
 const state=await h.state();expect(state.pending.name).toBe(proposal.name);expect(state.used).toEqual(h.initial.used);expect(state.owned).toEqual(h.initial.owned);expect(state.changes).toBe(0);
 expect(await readFile(join(h.root,'output/latest-change.md'),'utf8').catch(()=>null)).toBeNull();
 expect((await h.call('learning_save',input)).isError).toBe(true);expect(h.writes).toHaveLength(1);
}
for(const [field,value] of [['key','screenpipe-learned-other'],['name','screenpipe-learned-other'],['origin','user'],['description','Different trigger'],['instructions','Different method']])test(`matching hashes cannot verify a mismatched ${field}`,()=>uncertain({saved:{[field]:value}}));
test('changed readback hash stays uncertain',()=>uncertain({readback:{sha256:'other-sha'}}));
test('empty hashes cannot establish a saved method',()=>uncertain({saved:{sha256:''}}));
test('provider write failure preserves a pending receipt without retry',()=>uncertain({writeFailure:true}));
for(const mode of ['create','trim','patch'])test(`verified ${mode} preserves evidence, ownership and report`,async()=>{
 const h=await harness({patch:mode==='patch'}),evidence=await h.prepare();
 const input={...proposal,evidence,...(mode==='trim'?{description:` ${proposal.description} `,instructions:`\n${proposal.instructions}\n`}:{})};
 const result=await h.call('learning_save',input);expect(result.isError).not.toBe(true);expect(result.saved).toBe(proposal.name);
 expect(h.writes).toHaveLength(1);expect(h.writes[0].action).toBe(mode==='patch'?'patch':'create');if(mode==='patch')expect(h.writes[0].expected_sha256).toBe('old-sha');
 const state=await h.state();expect(state.pending).toBeUndefined();expect(state.owned[proposal.name]).toBe('new-sha');expect(state.used).toEqual(evidence);expect(state.changes).toBe(1);
 const report=await readFile(join(h.root,result.report),'utf8');expect(report).toContain(proposal.instructions);if(mode==='patch')expect(report).toContain('Previous short method.');
 expect((await h.call('learning_save',input)).isError).toBe(true);expect(h.writes).toHaveLength(1);
});
test('persisted uncertain write blocks another save after restart',async()=>{
 const initial={used:[],owned:{},changes:0,pending:{name:proposal.name,evidence:['one','two']}};
 const h=await harness({state:initial});expect((await h.call('learning_save',{...proposal,evidence:['one','two']})).isError).toBe(true);expect(h.writes).toEqual([]);expect(await h.state()).toEqual(initial);
});
