# screenpipe — AI that knows everything you've seen, said, or heard
# https://screenpipe.com
"""Read-only provider/binding inspection. Credentials and response bodies never leave memory."""
import json, os, urllib.request, urllib.error, re

def request(url, token, body=None, headers=None):
    request = urllib.request.Request(url, headers={"Authorization": "Bearer " + token, "Content-Type": "application/json", **(headers or {})}, data=json.dumps(body).encode() if body is not None else None)
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        try: payload = json.loads(error.read(65536))
        except Exception: payload = {}
        return error.code, payload

def summary(status, payload):
    error = payload.get('error', {}) if isinstance(payload, dict) else {}
    if not isinstance(error, dict): error = {}
    code = error.get('code')
    message = str(error.get('message', '')).lower()
    category = next((label for needle, label in [('sdp','sdp_validation'),('endpoint','endpoint'),('api key','credential'),('not supported','unsupported'),('permission','permission')] if needle in message), None)
    return {'status': status, 'code': code if isinstance(code,str) and re.fullmatch('[a-zA-Z0-9_]{1,80}',code) else None, 'category':category}

account = os.environ['CLOUDFLARE_ACCOUNT_ID']
cf_token = os.environ['CLOUDFLARE_API_TOKEN']
base = f'https://api.cloudflare.com/client/v4/accounts/{account}/workers/scripts/ai-proxy'
status, settings = request(base+'/settings', cf_token)
print('worker_settings',status)
bindings = settings.get('result',{}).get('bindings',[]) if status==200 else []
print('credential_bindings', json.dumps([b['name'] for b in bindings if b.get('name') in ['OPENAI_API_KEY','ADMIN_SECRET','AI_GATEWAY_SERVICE_TOKEN','CLOUDFLARE_AI_GATEWAY_TOKEN']]))
values={b.get('name'):b.get('text') for b in bindings if b.get('type')=='plain_text'}
gateway = values.get('CLOUDFLARE_AI_GATEWAY_ID')
release=values.get('SENTRY_RELEASE','')
print('deployed_source_release',release if re.fullmatch(r'[a-zA-Z0-9_.@/-]{1,100}',release) else 'unavailable')
print('gateway_binding_types',json.dumps([{k:b.get(k) for k in ('name','type')} for b in bindings if 'GATEWAY' in b.get('name','')]))
if not gateway:
    status, listed = request(f'https://api.cloudflare.com/client/v4/accounts/{account}/ai-gateway/gateways', cf_token)
    print('gateway_list_status',status)
    candidates = listed.get('result',[]) if status==200 else []
    print('gateway_count',len(candidates))
    if len(candidates)==1: gateway=candidates[0].get('id')
print('cloudflare_gateway_configured',bool(gateway))
status, deployments=request(base+'/deployments',cf_token)
if status==200:
    for deployment in deployments.get('result',{}).get('deployments',[])[:1]:
        print('current_versions',json.dumps(deployment.get('versions',[])))
        for version in deployment.get('versions',[]):
            vs, details = request(base+'/versions/'+version['version_id'],cf_token)
            print('version_annotations',json.dumps(details.get('result',{}).get('annotations',{})))
key = os.environ.get('OPENAI_API_KEY','')
if key:
    status, result=request('https://api.openai.com/v1/models/gpt-live-1',key)
    print('openai_live_model',json.dumps(summary(status,result)))
else: print('openai_repository_key_present',False)
# A malformed SDP is a bounded endpoint probe, never a conversation or recording.
if gateway:
    url=f'https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/openai/live/sessions'
    status,result=request(url,cf_token,{'session':{'model':'gpt-live-1','store':False,'delegation':{'type':'client'}},'transport':{'type':'webrtc','sdp':'invalid-synthetic-sdp'}}, {'cf-aig-authorization':'Bearer '+cf_token,'cf-aig-byok-alias':'default','cf-aig-collect-log-payload':'false','cf-aig-max-attempts':'1'})
    print('cloudflare_live_endpoint',json.dumps(summary(status,result)))
    session_id=result.get('session',{}).get('id') if isinstance(result,dict) else None
    if status in (200,201) and isinstance(session_id,str) and re.fullmatch('[a-zA-Z0-9_-]{1,200}',session_id):
        cleanup,_=request(url+'/'+session_id+'/hangup',cf_token,{}, {'cf-aig-authorization':'Bearer '+cf_token,'cf-aig-byok-alias':'default','cf-aig-collect-log-payload':'false'})
        print('unexpected_session_cleanup_status',cleanup)
