// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterAll, beforeEach, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createCipheriv, pbkdf2Sync } from 'node:crypto';

// Execute the real bridge and crypto with synthetic files. Never invoke a real
// credential command or network provider. This fixture currently targets macOS.
if (process.platform !== 'darwin') throw Error('This synthetic credential adapter requires macOS');
const realRead=fs.readFileSync, realExists=fs.existsSync;
const root=fs.mkdtempSync(join(tmpdir(),'grok-consent-'));
const home=join(root,'home'), dir=join(home,'Library','Application Support','Grok Bot');
const password='synthetic-safe-storage-password', token='synthetic-gateway-token';
const originalFetch=globalThis.fetch;
let reads,probes,commands,requests,rows,sequence,commandError,networkError;
mock.module('node:fs',()=>({...fs,
  readFileSync:(path,...args)=>{reads.push(String(path));return realRead(path,...args);},
  existsSync:path=>{probes.push(String(path));return realExists(path);},
}));
mock.module('node:child_process',()=>({execFileSync:(file,args)=>{
  commands.push({file,args});
  if(commandError)throw Error(token);
  if(file!=='/usr/bin/security'||!args.includes('Grok Bot Safe Storage'))throw Error('Unexpected credential adapter operation');
  return password;
}}));
const {runInstaller}=await import('../../../apps/screenpipe-app-tauri/lib/grokbot-installer.mjs');
const input=action=>({action,home,bun:'/synthetic/bun',dataDir:'/synthetic/recordings',port:3137,skill:'Synthetic public API reference.'});
const unrelated={id:'user-owned',source:'workflow',sourceRef:'https://example.invalid/user',name:'User workflow',body:'Preserve my workflow'};
function installFiles(){
  fs.mkdirSync(dir,{recursive:true});
  const cipher=createCipheriv('aes-128-cbc',pbkdf2Sync(password,'saltysalt',1003,16,'sha1'),Buffer.alloc(16,32));
  const clear=JSON.stringify({baseUrl:'https://synthetic.cursorvm.com/',token});
  const encrypted=Buffer.concat([Buffer.from('v10'),cipher.update(clear),cipher.final()]).toString('base64');
  fs.writeFileSync(join(dir,'sand-secrets.json'),JSON.stringify({'cursor-accounts':JSON.stringify({active:'fixture-account'})}));
  fs.writeFileSync(join(dir,'gateway-descriptor.json'),JSON.stringify({version:2,entries:{'fixture-account':{encrypted,savedAtMs:Date.now()-100}}}));
}
beforeEach(()=>{
  reads=[];probes=[];commands=[];requests=[];sequence=0;rows=[structuredClone(unrelated)];commandError=false;networkError=false;installFiles();
  globalThis.fetch=async(url,init)=>{
    requests.push({url:String(url),init});if(networkError)throw Error(token);
    expect(String(url).startsWith('https://synthetic.cursorvm.com/api/')).toBe(true);
    expect(init.method).toBe('POST');expect(init.redirect).toBe('error');
    expect(new Headers(init.headers).get('authorization')).toBe(`Bearer ${token}`);
    expect(init.body).not.toContain(token);
    const action=new URL(url).pathname.split('/').at(-1),args=JSON.parse(init.body);
    if(action==='listAgents')return Response.json([{id:'bot',isGroup:false}]);
    if(action==='getAgentWorkflows')return Response.json(rows);
    if(action==='createAgentWorkflow')rows.push({...args.spec,id:`owned-${++sequence}`,source:'workflow'});
    else if(action==='updateAgentWorkflow')rows=rows.map(row=>row.id===args.workflowId?{...row,...args.spec}:row);
    else if(action==='deleteAgentWorkflow')rows=rows.filter(row=>row.id!==args.workflowId);
    else throw Error('Unexpected synthetic gateway action');
    return Response.json(rows);
  };
});
afterAll(()=>{globalThis.fetch=originalFetch;fs.rmSync(root,{recursive:true,force:true});});
function noAccess(){expect(probes).toEqual([]);expect(reads).toEqual([]);expect(commands).toEqual([]);expect(requests).toEqual([]);expect(rows).toEqual([unrelated]);}
async function explicit(action){let result,failure;try{result=await runInstaller(input(action));}catch(error){failure=error;}expect(failure).toBeUndefined();return result;}
function safe(value){expect(JSON.stringify(value)).not.toContain(token);expect(JSON.stringify(value)).not.toContain(password);}
for(const action of ['status','automatic','',undefined,null,'CONNECT',true,{}])test(`non-explicit action ${JSON.stringify(action)} rejects before file discovery`,async()=>{
  await expect(runInstaller(input(action))).rejects.toThrow();noAccess();
});
test('passive status does not probe even when the app is absent',async()=>{
  fs.rmSync(dir,{recursive:true});await expect(runInstaller(input('status'))).rejects.toThrow();noAccess();
});
test('explicit connect verifies installation and retries without duplicates',async()=>{
  const first=await explicit('connect');expect(first.connected).toBe(true);safe(first);
  expect(reads).toContain(join(dir,'sand-secrets.json'));expect(reads).toContain(join(dir,'gateway-descriptor.json'));expect(commands).toHaveLength(1);
  expect(rows).toHaveLength(2);expect(rows[0]).toEqual(unrelated);safe(rows);
  requests=[];const second=await explicit('connect');expect(second.connected).toBe(true);safe(second);
  expect(rows).toHaveLength(2);expect(requests.every(r=>['listAgents','getAgentWorkflows'].includes(new URL(r.url).pathname.split('/').at(-1)))).toBe(true);
});
test('explicit disconnect removes owned installation and preserves user content',async()=>{
  await explicit('connect');requests=[];
  const result=await explicit('disconnect');expect(result.connected).toBe(false);safe(result);
  expect(rows).toEqual([unrelated]);expect(requests.some(r=>String(r.url).endsWith('/deleteAgentWorkflow'))).toBe(true);
});
for(const action of ['connect','disconnect'])test(`explicit ${action} with absent app needs no credentials or network`,async()=>{
  fs.rmSync(dir,{recursive:true});const result=await explicit(action);expect(result).toMatchObject({detected:false,connected:false});safe(result);
  expect(reads).toEqual([]);expect(commands).toEqual([]);expect(requests).toEqual([]);expect(rows).toEqual([unrelated]);
});
for(const kind of ['credential','network'])test(`explicit ${kind} failure reports no credentials and preserves unrelated workflow`,async()=>{
  commandError=kind==='credential';networkError=kind==='network';
  let failure;try{await runInstaller(input('connect'));}catch(error){failure=error;}
  expect(failure).toBeInstanceOf(Error);safe({message:failure.message});expect(rows).toEqual([unrelated]);
});
