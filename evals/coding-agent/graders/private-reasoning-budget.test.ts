// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterAll, beforeEach, expect, test } from 'bun:test';
import { createGlmEncryptedFetch } from '../../../crates/screenpipe-core/assets/extensions/lib/tinfoil-transport';
const base='https://gateway.invalid/v1',endpoint=`${base}/tinfoil/glm/chat/completions`,model='glm-5.3-flash-reap50-iq3m';
const originalFetch=globalThis.fetch;
let sent:any[],configs:any[],order:string[],readyFailure:boolean,plainCalls:number;
beforeEach(()=>{sent=[];configs=[];order=[];readyFailure=false;plainCalls=0;globalThis.fetch=async()=>{plainCalls++;throw Error('Plaintext fallback forbidden');};});
afterAll(()=>{globalThis.fetch=originalFetch;});
function adapter(){return createGlmEncryptedFetch(base,options=>{
 configs.push(options);return {ready:async()=>{order.push('ready');if(readyFailure)throw Error('Synthetic verification failure');},fetch:async(url,init)=>{
   order.push('fetch');sent.push({url:String(url),headers:new Headers(init?.headers),body:JSON.parse(String(init?.body)),redirect:init?.redirect});
   return new Response('data: [DONE]\n\n',{headers:{'Content-Type':'text/event-stream'}});
 }};
});}
function request(body:any={},token='synthetic-user-token',extra:any={}){return {method:'POST',headers:{'Content-Type':'application/json',Authorization:`Bearer ${token}`},body:JSON.stringify({model,messages:[{role:'user',content:'Synthetic task'}],...body}),...extra};}
async function send(body:any){const response=await adapter()(endpoint,request(body));expect(await response.text()).toContain('[DONE]');expect(sent).toHaveLength(1);expect(order).toEqual(['ready','fetch']);expect(plainCalls).toBe(0);return sent[0].body;}
for(const [effort,expected,budget] of [[undefined,'low',512],['off','low',512],['minimal','low',512],['low','low',512],['medium','low',512],['high','high',2048],['xhigh','max',4096],['max','max',4096],['unknown','low',512]] as const){
 test(`ordinary effort ${String(effort)} has supported reasoning settings`,async()=>{
   const body=await send({reasoning_effort:effort});expect(body.chat_template_kwargs).toMatchObject({enable_thinking:true,reasoning_effort:expected});expect(body.thinking_budget_tokens).toBe(budget);
 });
}
for(const [limits,expected] of [[{max_tokens:8192},4096],[{max_tokens:1536},512],[{max_completion_tokens:128},0],[{max_tokens:1024},0],[{max_tokens:1025},1],[{max_tokens:8192,max_completion_tokens:2048},1024]] as const){
 test(`reserves answer/tool output for ${JSON.stringify(limits)}`,async()=>{
   const body=await send({reasoning_effort:'max',...limits});expect(body.thinking_budget_tokens).toBe(expected);for(const [key,value] of Object.entries(limits))expect(body[key]).toBe(value);
 });
}
test('body-supplied overrides cannot defeat the bounded request policy',async()=>{
 const body=await send({reasoning_effort:'low',thinking_budget_tokens:999999,chat_template_kwargs:{enable_thinking:false,reasoning_effort:'max'}});
 expect(body.chat_template_kwargs).toMatchObject({enable_thinking:true,reasoning_effort:'low'});expect(body.thinking_budget_tokens).toBe(512);
});
test('verified request preserves auth, user content, redirect refusal and same-auth reuse',async()=>{
 const fetch=adapter();await (await fetch(endpoint,request())).text();await (await fetch(endpoint,request())).text();expect(configs).toHaveLength(1);
 expect(configs[0]).toMatchObject({baseURL:endpoint,transport:'ehbp'});expect(sent[0].url).toBe(endpoint);expect(sent[0].headers.get('authorization')).toBe('Bearer synthetic-user-token');expect(sent[0].redirect).toBe('error');expect(sent[0].body.messages).toContainEqual({role:'user',content:'Synthetic task'});
 await (await fetch(endpoint,request({},'rotated-synthetic-token'))).text();expect(configs).toHaveLength(2);expect(configs[0].userCacheSecret).not.toBe(configs[1].userCacheSecret);expect(sent[2].headers.get('authorization')).toBe('Bearer rotated-synthetic-token');expect(plainCalls).toBe(0);
});
for(const kind of ['model','destination','method','aborted','verification'])test(`rejects ${kind} failure without a model or plaintext request`,async()=>{
 const fetch=adapter();let url=endpoint,init=request();if(kind==='model')init=request({model:'other-model'});if(kind==='destination')url='https://other.invalid/v1/tinfoil/glm/chat/completions';if(kind==='method')init={method:'GET'} as any;if(kind==='aborted'){const controller=new AbortController();controller.abort();init=request({},undefined,{signal:controller.signal});}if(kind==='verification')readyFailure=true;
 await expect(fetch(url,init)).rejects.toThrow();expect(sent).toEqual([]);expect(plainCalls).toBe(0);
});
