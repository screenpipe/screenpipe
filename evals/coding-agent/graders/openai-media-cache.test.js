// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import {expect,test,mock,beforeEach} from 'bun:test';
const sent=[];
mock.module('openai',()=>({default:class OpenAI {
 chat={completions:{create:async params=>{
  sent.push(structuredClone(params));
  if(params.stream)return {controller:{abort(){}},async *[Symbol.asyncIterator](){yield {id:'synthetic',object:'chat.completion.chunk',created:1,model:params.model,choices:[{index:0,delta:{content:'synthetic completion'},finish_reason:null}]};yield {id:'synthetic',object:'chat.completion.chunk',created:1,model:params.model,choices:[{index:0,delta:{},finish_reason:'stop'}]};}};
  return {id:'synthetic',object:'chat.completion',created:1,model:params.model,choices:[{index:0,message:{role:'assistant',content:'synthetic completion'},finish_reason:'stop'}],usage:{prompt_tokens:3,completion_tokens:2,total_tokens:5}};
 }}};
}}));
mock.module('@sentry/cloudflare',()=>({captureException(){}}));
const {OpenAIProvider}=await import('../../../packages/ai-gateway/src/providers/openai.ts');
beforeEach(()=>{sent.length=0;});
const marker={mode:'explicit'};
const media=[
 {label:'image_url',input:{type:'image_url',image_url:{url:'data:image/png;base64,AA',detail:'high'}},expected:{type:'image_url',image_url:{url:'data:image/png;base64,AA',detail:'high'}}},
 {label:'native image',input:{type:'image',data:'AA',mimeType:'image/png'},expected:{type:'image_url',image_url:{url:'data:image/png;base64,AA',detail:'auto'}}},
 {label:'base64 image',input:{type:'image',source:{type:'base64',media_type:'image/png',data:'BB'}},expected:{type:'image_url',image_url:{url:'data:image/png;base64,BB',detail:'auto'}}},
];
async function call(stream,content,{history=true,model='gpt-5.6-luna'}={}){
 const provider=new OpenAIProvider('synthetic-test-key');
 const body={model,gpt56HistoryCacheEligible:history,messages:[{role:'system',content:'stable synthetic instruction'},{role:'user',content}],max_tokens:100};
 if(stream){const output=await provider.createStreamingCompletion(body);expect(await new Response(output).text()).toContain('synthetic completion');}
 else expect(JSON.stringify(await (await provider.createCompletion(body)).json())).toContain('synthetic completion');
 expect(sent).toHaveLength(1);return sent[0];
}
for(const stream of [false,true]){
 for(const part of media)test(`${stream?'stream':'completion'} keeps cache markers off ${part.label} and preserves preceding text caching`,async()=>{
  const params=await call(stream,[{type:'text',text:'inspect synthetic attachment'},structuredClone(part.input),{type:'text',text:''}]);
  expect(params.messages[1].content[1]).toEqual(part.expected);
  expect(params.messages[1].content[0].prompt_cache_breakpoint).toEqual(marker);
  expect(params.messages[1].content[2]).toEqual({type:'text',text:''});
  expect(params.messages[0].content[0].prompt_cache_breakpoint).toEqual(marker);
 });
 test(`${stream?'stream':'completion'} preserves media-only history without marking or dropping it`,async()=>{
  const params=await call(stream,media.map(p=>structuredClone(p.input)));expect(params.messages[1].content).toEqual(media.map(p=>p.expected));expect(params.messages[0].content[0].prompt_cache_breakpoint).toEqual(marker);
 });
 test(`${stream?'stream':'completion'} preserves the final nonempty text boundary`,async()=>{
  const params=await call(stream,[{type:'text',text:'earlier'},structuredClone(media[0].input),{type:'text',text:'latest'}]);
  expect(params.messages[1].content[0].prompt_cache_breakpoint).toBeUndefined();expect(params.messages[1].content[1]).toEqual(media[0].expected);expect(params.messages[1].content[2]).toEqual({type:'text',text:'latest',prompt_cache_breakpoint:marker});
 });
 test(`${stream?'stream':'completion'} preserves disabled history caching`,async()=>{
  const content=[{type:'text',text:'ordinary'},...media.map(p=>structuredClone(p.input))];const params=await call(stream,content,{history:false});expect(params.messages[1].content).toEqual([{type:"text",text:"ordinary"},...media.map(p=>p.expected)]);expect(params.messages[0].content[0].prompt_cache_breakpoint).toEqual(marker);
 });
 test(`${stream?'stream':'completion'} leaves older models without explicit cache fields`,async()=>{
  const content=[{type:'text',text:'ordinary'},...media.map(p=>structuredClone(p.input))];const params=await call(stream,content,{model:'gpt-5.4'});expect(params.messages[1].content).toEqual([{type:"text",text:"ordinary"},...media.map(p=>p.expected)]);expect(params.messages[0].content).toBe('stable synthetic instruction');expect(params.prompt_cache_options).toBeUndefined();expect(params.prompt_cache_key).toBeUndefined();
 });
}
