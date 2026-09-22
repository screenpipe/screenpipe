// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { beforeEach, afterAll, expect, mock, test } from 'bun:test';
let s, serial = 0;
const oldFetch = globalThis.fetch;
const audio = new Uint8Array([82,73,70,70,4,0,0,0,87,65,86,69]);
mock.module('@clerk/backend', () => ({verifyToken: async () => ({sub:s.subject})}));
const {handleRequest} = await import('../../../packages/ai-gateway/src/index');
const {__resetAuthEntitlementCacheForTests: reset} = await import('../../../packages/ai-gateway/src/utils/auth');
const env = {NODE_ENV:'production',CLERK_SECRET_KEY:'synthetic',DEEPGRAM_API_KEY:'synthetic',
 RATE_LIMITER:{idFromName:x=>x,get:()=>({fetch:async()=>Response.json(s.denied
 ? {allowed:false,standing:'denied',standing_reason:'banned'}
 : {allowed:true,standing:'good',remaining:10,reset_in:60,tier:'logged_in',rpm_limit:25})})},
 DB:{prepare:()=>{throw Error('Unexpected database operation');}}};
const ctx={waitUntil:()=>{},passThroughOnException:()=>{}};
beforeEach(()=>{
 reset?.(); s={subject:`user_probe_${++serial}`,plan:'standard',provider:[],lookups:0,denied:false,unknown:false};
 globalThis.fetch=async(input,init)=>{
  const url=String(input);
  if(url==='https://screenpipe.com/api/user'){
   s.lookups++; const paid=s.plan!=='none';
   return Response.json({success:true,user:s.unknown?{clerk_id:s.subject}:{clerk_id:s.subject,
    cloud_subscribed:s.plan==='pro',app_entitled:paid,subscription_plan:s.plan,
    entitlement:{active:paid,plan:s.plan,features:{app:paid,cloud:s.plan==='pro'}}}});
  }
  if(url.startsWith('https://api.deepgram.com/v1/speak')){s.provider.push({url,body:JSON.parse(init.body)});return new Response(audio);}
  throw Error('Unexpected network port');
 };
});
afterAll(()=>{globalThis.fetch=oldFetch;});
async function request(auth=true,text='synthetic speech'){
 return handleRequest(new Request('https://gateway.example.invalid/v1/text-to-speech',{
  method:'POST',headers:{'content-type':'application/json',...(auth?{authorization:'Bearer eyJ.synthetic.probe'}:{})},
  body:JSON.stringify({text})}),env,ctx);
}
async function refused(status,auth=true,text='synthetic speech'){
 const r=await request(auth,text);expect(r.status).toBe(status);expect(s.provider).toEqual([]);
 expect(r.headers.get('content-type')).toContain('application/json');
}
test('anonymous valid speech is refused before provider effect',()=>refused(401,false));
test('verified free valid speech is refused before provider effect',async()=>{s.plan='none';await refused(403);});
test('unknown plan cannot grant provider access',async()=>{s.unknown=true;await refused(503);});
for(const plan of ['standard','pro'])test(`${plan} retains exact provider audio and one effect`,async()=>{
 s.plan=plan;const r=await request();expect(r.status).toBe(200);expect(new Uint8Array(await r.arrayBuffer())).toEqual(audio);
 expect(r.headers.get('content-type')).toBe('audio/wav');expect(s.provider).toHaveLength(1);
 expect(s.provider[0].body).toEqual({text:'synthetic speech'});
});
test('denied good standing blocks paid provider access',async()=>{s.denied=true;await refused(403);});
test('paid invalid input remains refused without provider access',()=>refused(400,true,''));
