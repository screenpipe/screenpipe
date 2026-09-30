// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { beforeAll, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createServer } from 'node:http';
const pkg=resolve(__dirname,'..');
beforeAll(()=>execFileSync(process.env.BUN_BIN || 'bun',['run','build'],{cwd:pkg,timeout:120000}),130000);
async function scenario(mode:string, env:Record<string,string>={}, expectedKey='') {
 const home=mkdtempSync(join(tmpdir(),'mcp-db-boundary-'));mkdirSync(join(home,'.screenpipe'));
 const requests:{url:string;auth:string|undefined}[]=[];let trace='';
 const server=createServer((req,res)=>{requests.push({url:req.url||'',auth:req.headers.authorization});res.setHeader('content-type','application/json');
  if (!expectedKey || req.headers.authorization!==`Bearer ${expectedKey}`) {res.statusCode=403;res.end(JSON.stringify({error:'authentication required'}));}
  else res.end(JSON.stringify({data:[{type:'OCR',content:{text:'synthetic-recording-witness',timestamp:'2026-08-28T12:00:00Z',app_name:'Fixture',window_name:'Synthetic'}}],pagination:{total:1,offset:0}}));
 });
 await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));const address=server.address();if(!address || typeof address==='string') throw new Error('fixture bind failed');
 const client=new Client({name:'database-boundary-grader',version:'1.0.0'});
 const transport=new StdioClientTransport({command:process.execPath,args:['--require',join(pkg,'src/eval-db-boundary.preload.cjs'),join(pkg,'dist/index.js')],env:{HOME:home,USERPROFILE:home,PATH:'',SCREENPIPE_DISABLE_TELEMETRY:'1',SCREENPIPE_API_URL:`http://127.0.0.1:${address.port}`,SCREENPIPE_BUN_PATH:join(home,'synthetic-bun'),EVAL_AUTH_MODE:mode,...env},stderr:'pipe'});
 transport.stderr?.on('data',(chunk)=>{trace+=chunk.toString();});
 try {
  await client.connect(transport);
  const tools=(await client.listTools()).tools;expect(tools.some(t=>t.name==='search-content')).toBe(true);
  const results=[];
  for(let i=0;i<2;i++) results.push(await client.callTool({name:'search-content',arguments:{q:'witness',start_time:'2026-08-28T00:00:00Z',limit:1}}));
  await client.close();
  const ports=trace.split('\n').filter(l=>l.startsWith('EVAL_PORT ')).map(l=>JSON.parse(l.slice(10)));
  expect(ports.filter(p=>p.kind==='unexpected-command')).toEqual([]);
  expect(ports.filter(p=>p.kind==='database-io' || p.kind==='database-probe' || (p.kind==='command' && /sqlite3/i.test(p.value)))).toEqual([]);
  const searches=requests.filter(r=>r.url.startsWith('/search?'));expect(searches).toHaveLength(2);
  if(expectedKey){
   expect(searches.map(r=>r.auth)).toEqual([`Bearer ${expectedKey}`,`Bearer ${expectedKey}`]);
   for(const result of results){expect(result.isError).not.toBe(true);expect(JSON.stringify(result.content)).toContain('synthetic-recording-witness');}
  }else{
   expect(requests.every(r=>!r.auth || r.auth==='Bearer ')).toBe(true);
   for(const result of results) expect(result.isError).toBe(true);
   expect(trace).toContain('SCREENPIPE_LOCAL_API_KEY');
  }
  expect(trace).not.toContain('sp-synthetic-database-key');
  return ports;
 } finally {await client.close();await new Promise<void>(resolve=>{server.close(()=>resolve());server.closeAllConnections();});rmSync(home,{recursive:true,force:true});}
}
it('missing credentials and failed CLI never fall back to the recording database',()=>scenario('missing'),15000);
it('invalid CLI output never enables database fallback or authenticated success',()=>scenario('invalid-cli'),15000);
it('explicit local credentials win over the legacy environment key',async()=>{const p=await scenario('missing',{SCREENPIPE_LOCAL_API_KEY:'sp-synthetic-local',SCREENPIPE_API_KEY:'sp-synthetic-legacy'},'sp-synthetic-local');expect(p.filter(p=>p.kind==='command')).toEqual([]);},15000);
it('legacy environment credentials remain supported',async()=>{const p=await scenario('missing',{SCREENPIPE_API_KEY:'sp-synthetic-legacy'},'sp-synthetic-legacy');expect(p.filter(p=>p.kind==='command')).toEqual([]);},15000);
for(const mode of ['bundled','adjacent','path']) it(`${mode} CLI credentials preserve authenticated search and one discovery across calls`,async()=>{const p=await scenario(mode,{},'sp-synthetic-cli-key');expect(p.filter(p=>p.kind==='command')).toHaveLength(1);},15000);
