# screenpipe — AI that knows everything you've seen, said, or heard
# https://screenpipe.com
import hashlib,json,pathlib,urllib.request,urllib.error,time,os
base='http://127.0.0.1:3040/api/enterprise/v1/search?q=roadmap&since=2026-07-22T00:00:00Z&until=2026-07-23T00:00:00Z'
raw='sk_ent_'+'a'*64
def fetch(url,token=None):
 try:
  with urllib.request.urlopen(urllib.request.Request(url,headers={'Authorization':'Bearer '+token} if token else {}),timeout=5) as r: return r.status,json.load(r)
 except urllib.error.HTTPError as e: return e.code,{}
for attempt in range(75):
 try:
  code,data=fetch(base,raw)
  if code==200 and data.get('result_count')==5: break
 except Exception: pass
 time.sleep(2)
else: raise RuntimeError('gateway did not ingest five fixture records')
assert sorted(x['kind'] for x in data['results'])==['audio','frame','memory','parsed','ui']
assert fetch(base)[0]==401,'anonymous request accepted'
assert fetch(base,'sk_ent_'+'b'*64)[0]==401,'unknown token accepted'
assert fetch(base+'&device_id=dev-other',raw)[1]['result_count']==0,'device filter failed'
assert fetch(base.replace('q=roadmap','q=foreign-tenant-sentinel'),raw)[1]['result_count']==0,'tenant isolation failed'
registration=pathlib.Path('/var/lib/screenpipe/gateway-registration.json')
assert registration.exists(),'missing enrollment persistence'
assert os.path.ismount('/var/lib/screenpipe'),'index not on persistent disk'
assert pathlib.Path('/run/screenpipe-gateway.env').stat().st_mode & 0o077==0,'runtime env readable by non-root'
config=json.loads(pathlib.Path('/etc/screenpipe/runtime.json').read_text())
if config['cloud']=='azure':
 token=json.load(urllib.request.urlopen(urllib.request.Request('http://169.254.169.254/metadata/identity/oauth2/token?api-version=2018-02-01&resource=https%3A%2F%2Fstorage.azure.com%2F',headers={'Metadata':'true'})))['access_token']
 request=urllib.request.Request('https://'+config['account']+'.blob.core.windows.net/'+config['container']+'/reader-must-not-write.txt',data=b'forbidden fixture write',method='PUT',headers={'Authorization':'Bearer '+token,'x-ms-blob-type':'BlockBlob','x-ms-version':'2023-11-03'})
else:
 token=json.load(urllib.request.urlopen(urllib.request.Request('http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token',headers={'Metadata-Flavor':'Google'})))['access_token']
 request=urllib.request.Request('https://storage.googleapis.com/upload/storage/v1/b/'+config['bucket']+'/o?uploadType=media&name=reader-must-not-write.txt',data=b'forbidden fixture write',method='POST',headers={'Authorization':'Bearer '+token,'Content-Type':'text/plain'})
try:
 urllib.request.urlopen(request)
 raise AssertionError('reader identity unexpectedly has write access')
except urllib.error.HTTPError as error:
 assert error.code==403,'reader denial was not an authorization denial'
print(json.dumps({'reader_write_denied':True,'search_count':data['result_count'],'kinds':sorted(x['kind'] for x in data['results']),'anonymous_denied':True,'invalid_token_denied':True,'device_filter':True,'tenant_isolation':True,'persistent_disk':True,'registration_sha256':hashlib.sha256(registration.read_bytes()).hexdigest()}))
