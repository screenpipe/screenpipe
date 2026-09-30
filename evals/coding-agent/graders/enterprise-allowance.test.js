// screenpipe — AI that knows everything you've seen, said, or heard
// https://screenpipe.com
import { beforeEach, afterEach, afterAll, expect, mock, test } from 'bun:test';
const originalFetch=globalThis.fetch,subject='user_enterprise_fixture',token='eyJ.synthetic.enterprise';
let state;
mock.module('@clerk/backend',()=>({verifyToken:async()=>({sub:subject})}));
// Unrelated provider import added on newer main; no provider request is executed.
mock.module('../../../packages/ai-gateway/src/providers/screenpipe-glm',()=>({SCREENPIPE_GLM_MODEL:'synthetic-glm-unused'}));
globalThis.fetch=async (url,options)=>{
 state.calls.push({url:String(url),body:JSON.parse(options.body)});
 if(String(url)!=='https://screenpipe.com/api/user'){state.unexpected.push(String(url));throw Error('network forbidden');}
 return Response.json(state.body,{status:state.status});
};
const auth=await import('../../../packages/ai-gateway/src/utils/auth');
const gateway=await import('../../../packages/ai-gateway/src/services/cloudflare-ai-gateway');
const env={CLERK_SECRET_KEY:'fixture',AI_GATEWAY_SERVICE_TOKEN:'fixture-service',CLOUDFLARE_AI_GATEWAY_ID:'fixture-gateway',CLOUDFLARE_AI_GATEWAY_BASE_URL:'https://gateway.ai.cloudflare.com/v1/fixture-account/fixture-gateway'};
function user(extra={}){return {clerk_id:subject,cloud_subscribed:true,app_entitled:true,subscription_plan:'pro',billing_plan:'pro',is_enterprise_user:true,entitlement:{plan:'pro',active:true,features:{app:true}},...extra};}
beforeEach(()=>{auth.__resetAuthEntitlementCacheForTests?.();state={calls:[],unexpected:[],status:200,body:{success:true,user:user()}};});
afterEach(()=>expect(state.unexpected).toEqual([]));afterAll(()=>{globalThis.fetch=originalFetch;});
function run(credential=token,device='fixture-device'){return auth.validateAuth(new Request('https://gateway.fixture.invalid/chat',{headers:{'X-Device-Id':device,...(credential?{Authorization:`Bearer ${credential}`}:{})}}),env);}
async function joined(plan='business_ultra',provider='openai'){
 const verified=await run();const context=await gateway.buildHostedChatGatewayContext(verified,'auto','background');
 const connection=await gateway.getHostedChatGatewayConnection(env,provider,context);
 expect(context.plan).toBe(plan);expect(context).toMatchObject({lane:'auto',workload:'background',trial:false});
 expect(context.user_id).toMatch(/^[a-f0-9]{64}$/);expect(context.user_id).not.toContain(subject);
 expect(JSON.parse(connection.defaultHeaders['cf-aig-metadata'])).toEqual(context);
 expect(connection.baseURL).toBe(`https://gateway.ai.cloudflare.com/v1/fixture-account/fixture-gateway/${provider}`);
 expect(connection.maxRetries).toBe(0);expect(connection.defaultHeaders['cf-aig-collect-log-payload']).toBe('false');
 expect(connection.defaultHeaders[provider==='openai'?'Authorization':'x-api-key']).toBeNull();
 expect(JSON.stringify(connection)).not.toContain(token);expect(JSON.stringify(connection)).not.toContain(subject);
 for(const call of state.calls)expect(call).toEqual({url:'https://screenpipe.com/api/user',body:{token}});
 return {verified,context};
}
for(const billing of ['pro','pro_max','pro_ultra'])test(`verified enterprise overrides compatible consumer ${billing} through gateway metadata`,async()=>{
 state.body.user.billing_plan=billing;const {verified}=await joined();expect(verified).toMatchObject({accountPlan:'enterprise',userId:subject,isValid:true});
});
test('enterprise context reaches the Anthropic gateway without a provider credential',async()=>{await joined('business_ultra','anthropic');});
for(const flag of [false,undefined,'true'])test(`unverified enterprise flag ${String(flag)} preserves consumer allowance`,async()=>{state.body.user.is_enterprise_user=flag;await joined('business');});
for(const [billing,plan] of [['pro_max','business_max'],['pro_ultra','business_ultra']])test(`consumer ${billing} retains purchased capacity`,async()=>{state.body.user.is_enterprise_user=false;state.body.user.billing_plan=billing;await joined(plan);});
for(const kind of ['inactive','app denied','missing app feature','mismatched entitlement','incompatible billing','wrong subject','failed response'])test(`${kind} cannot promote enterprise metadata into paid capacity`,async()=>{
 const u=state.body.user;
 if(kind==='inactive')u.entitlement.active=false;
 if(kind==='app denied')u.app_entitled=false;
 if(kind==='missing app feature')u.entitlement.features={};
 if(kind==='mismatched entitlement')u.entitlement.plan='standard';
 if(kind==='incompatible billing')u.billing_plan='standard';
 if(kind==='wrong subject')u.clerk_id='user_other_fixture';
 if(kind==='failed response')state.body.success=false;
 const result=await run();expect(result.accountPlan).toBe('unknown');
 await expect(gateway.buildHostedChatGatewayContext(result,'auto','interactive')).rejects.toThrow();
});
test('explicit app/cloud denial remains free despite stale enterprise flag',async()=>{state.body.user.app_entitled=false;state.body.user.cloud_subscribed=false;await joined('free');});
test('verified account identity is stable across device changes',async()=>{
 const first=await run();const second=await run(token,'second-device');
 const a=await gateway.buildHostedChatGatewayContext(first,'auto','background');
 const b=await gateway.buildHostedChatGatewayContext(second,'auto','interactive');
 expect(a.user_id).toBe(b.user_id);expect(a.plan).toBe('business_ultra');expect(b.workload).toBe('interactive');expect(state.calls).toHaveLength(1);
});
test('service credential retains internal allowance without website lookup',async()=>{
 const value=await run(env.AI_GATEWAY_SERVICE_TOKEN);expect(value.service).toBe(true);
 expect((await gateway.buildHostedChatGatewayContext(value,'auto','background')).plan).toBe('internal');expect(state.calls).toEqual([]);
});
test('anonymous request never gains an account or enterprise allowance',async()=>{
 const value=await run(null);expect(value).toMatchObject({tier:'anonymous',accountPlan:'unknown'});expect(state.calls).toEqual([]);
 await expect(gateway.buildHostedChatGatewayContext(value,'auto','background')).rejects.toThrow();
});
