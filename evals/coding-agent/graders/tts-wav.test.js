// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { beforeEach, afterEach, expect, test } from 'bun:test';
import { resolve } from 'node:path';
const root=process.cwd();
async function load(path){
 const built=await Bun.build({entrypoints:[resolve(root,path)],target:'bun',write:false,plugins:[{name:'synthetic-unrelated-ports',setup(build){
  build.onResolve({filter:/^(@deepgram\/sdk|\.\.\/providers)$/},args=>({path:args.path,namespace:'unrelated'}));
  build.onLoad({filter:/.*/,namespace:'unrelated'},args=>({contents:args.path==='@deepgram/sdk'?'export function createClient(){throw Error("Unrelated transcription forbidden")}':'export function createProvider(){throw Error("Unrelated completion forbidden")}',loader:'js'}));
 }}]});
 if(!built.success)throw Error('Cannot find module or compile source: '+built.logs.map(String).join('\n'));
 return import('data:text/javascript;base64,'+Buffer.from(await built.outputs[0].text()).toString('base64'));
}
const {handleTextToSpeech}=await load('packages/ai-gateway/src/handlers/voice.ts');
const {textToSpeech}=await load('packages/ai-gateway/src/utils/voice-utils.ts');
const wav=Uint8Array.from([82,73,70,70,38,0,0,0,87,65,86,69,102,109,116,32,16,0,0,0,1,0,1,0,128,62,0,0,0,125,0,0,2,0,16,0,100,97,116,97,2,0,0,0,0,0]);
const env={DEEPGRAM_API_KEY:'synthetic-provider-key'};let calls,reply;const originalFetch=globalThis.fetch;
beforeEach(()=>{calls=[];reply=()=>new Response(wav);globalThis.fetch=async(input,init)=>{const url=new URL(String(input));expect(url.origin+url.pathname).toBe('https://api.deepgram.com/v1/speak');calls.push({url,init});return reply();};});
afterEach(()=>{globalThis.fetch=originalFetch;});
function request(body){return new Request('https://gateway.example.invalid/v1/text-to-speech',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});}
async function success(body={text:'Synthetic speech'},voice='aura-asteria-en'){
 const r=await handleTextToSpeech(request(body),env);expect(r.status).toBe(200);expect(r.headers.get('content-type')).toBe('audio/wav');expect(new Uint8Array(await r.arrayBuffer())).toEqual(wav);expect(calls).toHaveLength(1);
 const {url,init}=calls[0];expect(url.searchParams.get('model')).toBe(voice);expect(url.searchParams.get('encoding')).toBe('linear16');expect(url.searchParams.get('container')).toBe('wav');expect(init.method).toBe('POST');expect(JSON.parse(init.body)).toEqual({text:body.text});expect(new Headers(init.headers).get('authorization')).toBe('Token synthetic-provider-key');
}
test('default handler requests WAV PCM and preserves actual provider bytes',()=>success());
test('explicit supported voice and literal text survive the request',()=>success({text:'  Synthetic "speech"\nsecond line 🧪',voice:'aura-luna-en'},'aura-luna-en'));
const bad=[['empty',new Uint8Array()],['short RIFF',Uint8Array.from([82,73,70,70])],['eleven bytes',wav.slice(0,11)],['MP3',Uint8Array.from([255,243,96,196])],['wrong RIFF',Uint8Array.from(wav.map((v,i)=>i===0?0:v))],['wrong WAVE',Uint8Array.from(wav.map((v,i)=>i===8?0:v))]];
for(const [name,bytes] of bad)test(`rejects ${name} instead of labelling it audio/wav`,async()=>{reply=()=>new Response(bytes);const r=await handleTextToSpeech(request({text:'Synthetic speech'}),env);expect(r.status).toBe(500);expect(r.headers.get('content-type')).toContain('application/json');expect((await r.json()).error).toBeTruthy();expect(calls).toHaveLength(1);});
for(const kind of ['HTTP','transport','body'])test(`provider ${kind} failure refuses audio; explicit retry can recover`,async()=>{reply=()=>{if(kind==='transport')throw Error('synthetic offline');if(kind==='body')return {ok:true,arrayBuffer:async()=>{throw Error('synthetic body failure')}};return new Response('synthetic unavailable',{status:503});};const r=await handleTextToSpeech(request({text:'Synthetic speech'}),env);expect(r.status).toBe(500);expect(r.headers.get('content-type')).toContain('application/json');expect((await r.json()).error).toBeTruthy();expect(calls).toHaveLength(1);calls=[];reply=()=>new Response(wav);await success();});
test('missing, nonstring and invalid voice requests refuse before provider access',async()=>{for(const body of [{},{text:5},{text:''},{text:'hello',voice:'unsupported-model'}]){const r=await handleTextToSpeech(request(body),env);expect(r.status).toBe(400);expect((await r.json()).error).toBeTruthy();}expect(calls).toEqual([]);});
test('whitespace-only text fails without a provider request',async()=>{const r=await handleTextToSpeech(request({text:' \n\t'}),env);expect(r.status).toBe(500);expect((await r.json()).error).toBeTruthy();expect(calls).toEqual([]);});
test('non-WAV utility encoding remains supported without a WAV container',async()=>{const mp3=Uint8Array.from([255,243,96,196,7,8]);reply=()=>new Response(mp3);expect(new Uint8Array(await textToSpeech('Synthetic mp3',env,{encoding:'mp3',voice:'aura-luna-en'}))).toEqual(mp3);expect(calls).toHaveLength(1);expect(calls[0].url.searchParams.get('encoding')).toBe('mp3');expect(calls[0].url.searchParams.has('container')).toBe(false);});
test('rejection of wrong bytes does not poison a later explicit WAV request',async()=>{reply=()=>new Response(Uint8Array.from([1,2,3]));expect((await handleTextToSpeech(request({text:'Synthetic speech'}),env)).status).toBe(500);calls=[];reply=()=>new Response(wav);await success();});
