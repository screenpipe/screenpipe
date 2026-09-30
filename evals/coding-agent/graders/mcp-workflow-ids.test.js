// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { expect, test } from 'bun:test';
import { readWorkflowTool } from '../../../packages/screenpipe-mcp/src/workflow-tools.ts';
const ids = ['wf-12345678-1234-4234-8234-123456789abc', 'wf-abcdef01-2345-6789-abcd-ef0123456789', `wf-${'a'.repeat(64)}`];
for (const id of ids) for (const include of [undefined, true, false]) {
  test(`retrieves ${id} with automation ${include}`, async () => {
    const seen=[];const payload={id,workflow:{stages:[{name:'Synthetic review',unknownField:{keep:true}}]},automationEvidence:[{status:'no_captured_frame'}]};
    const result=await readWorkflowTool('get-workflow',{id,...(include===undefined?{}:{include_automation:include})},async endpoint=>{seen.push(endpoint);return Response.json(payload);});
    expect(seen).toHaveLength(1);const url=new URL(seen[0],'http://fixture.invalid');
    expect(url.pathname).toBe(`/workflows/${id}`);expect(url.searchParams.get('include_automation')).toBe(String(include!==false));expect([...url.searchParams.keys()]).toEqual(['include_automation']);
    expect(result.content).toHaveLength(1);expect(result.content[0].type).toBe('text');expect(JSON.parse(result.content[0].text)).toEqual(payload);
  });
}
test('lists workflows and retrieves the maintained ID returned by that list',async()=>{
 const requests=[];const id=ids[0];const call=async endpoint=>{requests.push(endpoint);return Response.json(endpoint.startsWith('/workflows?')?{data:[{id,title:'Synthetic workflow'}]}:{id,workflow:{stages:[]}});};
 const list=await readWorkflowTool('list-workflows',{},call);const chosen=JSON.parse(list.content[0].text).data[0].id;
 const detail=await readWorkflowTool('get-workflow',{id:chosen},call);expect(JSON.parse(detail.content[0].text).id).toBe(id);expect(requests).toHaveLength(2);
});
test('preserves empty catalogs and safely encodes search and pagination',async()=>{
 for(const args of [{},{q:'a&offset=999 / ? # +',limit:100,offset:0},{limit:1,offset:900}]){
  const seen=[];const result=await readWorkflowTool('list-workflows',args,async endpoint=>{seen.push(endpoint);return Response.json({data:[],pagination:{total:0}});});
  expect(seen).toHaveLength(1);const url=new URL(seen[0],'http://fixture.invalid');expect(url.pathname).toBe('/workflows');
  expect(Object.fromEntries(url.searchParams)).toEqual(Object.fromEntries(Object.entries(args).map(([k,v])=>[k,String(v)])));expect(JSON.parse(result.content[0].text)).toEqual({data:[],pagination:{total:0}});
 }
});
test('rejects malformed IDs and path/query injection before any backend request',async()=>{
 const invalid=[undefined,null,7,'wf-','wf-1234',`wf-${'a'.repeat(63)}`,`wf-${'a'.repeat(65)}`,'wf-12345678-1234-4234-8234-123456789abz','wf-12345678123442348234123456789abc',`${ids[0]}/../catalog`,`${ids[0]}?include_automation=false`,`${ids[0]}#fragment`,`${ids[0]}%2f..`,`${ids[0]}\n`,`${ids[0]} `,` ${ids[0]}`];
 for(const id of invalid){let calls=0;await expect(readWorkflowTool('get-workflow',{id},async()=>{calls++;return Response.json({});})).rejects.toThrow();expect(calls).toBe(0);}
});
test('rejects nonboolean automation options before any backend request',async()=>{
 for(const include_automation of ['false',0,1,null,{}]){let calls=0;await expect(readWorkflowTool('get-workflow',{id:ids[2],include_automation},async()=>{calls++;return Response.json({});})).rejects.toThrow();expect(calls).toBe(0);}
});
test('rejects invalid list inputs and unknown tools before requests',async()=>{
 for(const args of [{q:7},{limit:0},{limit:101},{limit:1.5},{limit:'1'},{offset:-1},{offset:1.5},{offset:Number.MAX_SAFE_INTEGER+1}]){let calls=0;await expect(readWorkflowTool('list-workflows',args,async()=>{calls++;return Response.json({});})).rejects.toThrow();expect(calls).toBe(0);}
 let calls=0;await expect(readWorkflowTool('execute-workflow',{id:ids[2]},async()=>{calls++;return Response.json({});})).rejects.toThrow();expect(calls).toBe(0);
});
for(const failure of ['http','transport','json'])test(`provider ${failure} failure is not an empty success; explicit retry can recover`,async()=>{
 let calls=0;const call=async()=>{calls++;if(calls===1){if(failure==='transport')throw Error('synthetic offline');if(failure==='http')return new Response('{}',{status:503});return new Response('{',{status:200});}return Response.json({id:ids[2],workflow:{stages:[]}});};
 await expect(readWorkflowTool('get-workflow',{id:ids[2]},call)).rejects.toThrow();expect(calls).toBe(1);
 const result=await readWorkflowTool('get-workflow',{id:ids[2]},call);expect(calls).toBe(2);expect(JSON.parse(result.content[0].text).id).toBe(ids[2]);
});
