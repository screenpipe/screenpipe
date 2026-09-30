// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { afterAll, beforeEach, expect, mock, test } from 'bun:test';
let requests,payload,content,native,chunkSize;
const originalFetch=globalThis.fetch;
mock.module('openai',()=>({default:class{
 constructor(options){this.baseURL=options.baseURL;}
 chat={completions:{create:async params=>{
  requests.push(structuredClone(params));
  if(!params.stream)return structuredClone(payload);
  return {controller:{abort(){}},async *[Symbol.asyncIterator](){
   if(native)yield {choices:[{delta:{tool_calls:native.map((c,index)=>({index,...c}))},finish_reason:null}]};
   else for(let i=0;i<content.length;i+=chunkSize)yield {choices:[{delta:{content:content.slice(i,i+chunkSize)},finish_reason:null}]};
   yield {choices:[{delta:{},finish_reason:native?'tool_calls':'stop'}]};
  }};
 }}};
}}));
mock.module('@sentry/cloudflare',()=>({captureException:()=>{throw Error('Unexpected provider error');}}));
globalThis.fetch=async()=>{throw Error('Network forbidden');};afterAll(()=>{globalThis.fetch=originalFetch;});
const {ScreenpipeGlmProvider}=await import('../../../packages/ai-gateway/src/providers/screenpipe-glm');
const {OpenAIProvider}=await import('../../../packages/ai-gateway/src/providers/openai');
const args={path:'synthetic/σ.txt',count:2,enabled:true,options:{mode:'read'},code:'001'};
const tool={type:'function',function:{name:'read',parameters:{type:'object',properties:{path:{type:'string'},count:{type:'number'},enabled:{type:'boolean'},options:{type:'object'},code:{type:'string'}}}}};
const xml='<tool_call>read<arg_key>path</arg_key><arg_value>synthetic/σ.txt</arg_value><arg_key>count</arg_key><arg_value>2</arg_value><arg_key>enabled</arg_key><arg_value>true</arg_value><arg_key>options</arg_key><arg_value>{"mode":"read"}</arg_value><arg_key>code</arg_key><arg_value>001</arg_value></tool_call>';
beforeEach(()=>{requests=[];native=null;chunkSize=7;content='';});
async function invoke(text,mode,tools=[tool],otherProvider=false,nativeCalls=null){
 content=text;native=nativeCalls;chunkSize=mode==='stream-one'?1:7;
 payload={id:'synthetic-completion',choices:[{message:{role:'assistant',content:native?null:text,...(native?{tool_calls:native}:{})},finish_reason:native?'tool_calls':'stop'}]};
 const input={model:otherProvider?'gpt-4o':'glm-5.3-flash-reap50-iq3m',messages:[{role:'user',content:'Use the disclosed synthetic tool when needed.'}],...(tools===undefined?{}:{tools,tool_choice:'auto'})};
 const before=structuredClone(input),provider=otherProvider?new OpenAIProvider('synthetic'):new ScreenpipeGlmProvider('synthetic');let result;
 if(mode==='completion'){
  const response=await provider.createCompletion(input);expect(response.status).toBe(200);const body=await response.json();result={calls:body.choices[0].message.tool_calls||[],text:body.choices[0].message.content||'',finishes:[body.choices[0].finish_reason]};
 }else{
  const stream=await provider.createStreamingCompletion(input);const raw=await new Response(stream).text();expect(raw.split('data: [DONE]').length-1).toBe(1);
  const events=raw.split('\n').filter(s=>s.startsWith('data: ')&&s!=='data: [DONE]').map(s=>JSON.parse(s.slice(6)));
  result={calls:events.flatMap(e=>e.choices?.[0]?.delta?.tool_calls||[]),text:events.map(e=>e.choices?.[0]?.delta?.content||'').join(''),finishes:events.map(e=>e.choices?.[0]?.finish_reason).filter(Boolean)};
 }
 expect(input).toEqual(before);expect(requests).toHaveLength(1);return result;
}
function converted(result,expected){
 expect(result.calls).toHaveLength(expected.length);expect(result.text).toBe('');expect(result.finishes.at(-1)).toBe('tool_calls');const ids=[];
 for(let i=0;i<expected.length;i++){const call=result.calls[i];expect(call.type).toBe('function');expect(call.function.name).toBe('read');expect(JSON.parse(call.function.arguments)).toEqual(expected[i]);expect(typeof call.id).toBe('string');expect(call.id.length).toBeGreaterThan(0);ids.push(call.id);}
 expect(new Set(ids).size).toBe(ids.length);expect(requests[0].tools).toEqual([tool]);expect(requests[0].tool_choice).toBe('auto');
}
const forms=[['tagged XML',xml,[args]],['flat JSON',JSON.stringify({name:'read',arguments:args}),[args]],['nested JSON string',JSON.stringify({function:{name:'read',arguments:JSON.stringify(args)}}),[args]],['XML JSON','<tool_call>read'+JSON.stringify(args)+'</tool_call>',[args]],['multiple XML',xml+'\n<tool_call>read{"path":"second.txt"}</tool_call>',[args,{path:'second.txt'}]]];
const ordinary=['<tool_call>unknown{}','Here is an example: '+xml,JSON.stringify({name:'unknown',arguments:{}}),'{invalid json',JSON.stringify({name:'read',arguments:[]}),JSON.stringify({name:'read',arguments:null})];
for(const mode of ['completion','stream-one','stream-seven']){
 for(const [name,text,expected] of forms)test(`${mode}: converts ${name} through actual provider`,async()=>converted(await invoke(text,mode),expected));
 for(const text of ordinary)test(`${mode}: unrecognized content stays text ${text.slice(0,35)}`,async()=>{const r=await invoke(text,mode);expect(r.calls).toEqual([]);expect(r.text).toBe(text);if(mode!=='completion')expect(r.finishes.at(-1)).toBe('stop');});
 test(`${mode}: absent tools do not turn text into executable calls`,async()=>{const r=await invoke(xml,mode,[]);expect(r.calls).toEqual([]);expect(r.text).toBe(xml);});
 test(`${mode}: native provider tool calls keep their identity and arguments`,async()=>{const calls=[{id:'native_read_fixture',type:'function',function:{name:'read',arguments:JSON.stringify(args)}}];const r=await invoke('',mode,[tool],false,calls);expect(r.calls).toHaveLength(1);expect(r.calls[0]).toMatchObject(calls[0]);if(mode!=='completion')expect(r.finishes.at(-1)).toBe('tool_calls');});
 test(`${mode}: other OpenAI provider preserves identical ordinary content`,async()=>{const r=await invoke(xml,mode,[tool],true);expect(r.calls).toEqual([]);expect(r.text).toBe(xml);});
}
