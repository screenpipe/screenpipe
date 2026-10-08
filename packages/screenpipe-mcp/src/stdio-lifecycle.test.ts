// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { it, expect } from "vitest";
import { spawn, execFileSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import path from "node:path";
const sleep=(ms:number)=>new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate:()=>boolean, timeout=2000) {
  const end=Date.now()+timeout;
  while(!predicate() && Date.now()<end) await sleep(10);
  expect(predicate()).toBe(true);
}
it("reaps a helper on EOF during a hung read while another client remains usable",async()=>{
  const root=path.resolve(__dirname,"..");
  execFileSync("bun",["run","build"],{cwd:root,stdio:"pipe",timeout:120000});
  let hanging=false;
  const api=createServer((req,res)=>{
    if(req.url?.includes("q=hang")){hanging=true;return;}
    res.setHeader("Content-Type","application/json");res.end(JSON.stringify({data:[],pagination:{total:0}}));
  });
  await new Promise<void>(resolve=>api.listen(0,"127.0.0.1",resolve));
  const address=api.address();if(!address||typeof address==='string')throw new Error('fixture unavailable');
  const port=address.port;
  const children:ChildProcessWithoutNullStreams[]=[];
  async function start(){
    const child=spawn(process.execPath,[path.join(root,'dist/cli.js')],{env:{PATH:process.env.PATH||'',SCREENPIPE_LOCAL_API_KEY:'fixture',SCREENPIPE_LOCAL_API_URL:`http://127.0.0.1:${port}`,SCREENPIPE_DISABLE_TELEMETRY:'1'},stdio:'pipe'});
    children.push(child);let output='';child.stdout.on('data',part=>output+=part);child.stderr.resume();
    const send=(value:unknown)=>child.stdin.write(JSON.stringify(value)+'\n');
    send({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'test',version:'1'}}});
    await until(()=>output.includes('"id":1'));
    send({jsonrpc:'2.0',method:'notifications/initialized'});
    return {child,send,output:()=>output};
  }
  try{
    const abandoned=await start(), live=await start();
    abandoned.send({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'search-content',arguments:{q:'hang'}}});
    await until(()=>hanging);abandoned.child.stdin.end();
    await until(()=>abandoned.child.exitCode!==null);
    expect(live.child.exitCode).toBeNull();
    live.send({jsonrpc:'2.0',id:2,method:'tools/call',params:{name:'search-content',arguments:{}}});
    await until(()=>live.output().includes('No results'));
    live.child.stdin.end();await until(()=>live.child.exitCode!==null);
  } finally {
    for(const child of children)if(child.exitCode===null&&child.signalCode===null){child.kill('SIGKILL');await once(child,'exit');}
    api.closeAllConnections();await new Promise<void>(resolve=>api.close(()=>resolve()));
  }
},15000);
