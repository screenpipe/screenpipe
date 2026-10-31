# screenpipe — AI that knows everything you've seen, said, or heard
# https://screenpipe.com
import pathlib,subprocess,os,json,time,signal,sqlite3,platform
from PIL import Image
r=pathlib.Path.home()/'redaction';out=r/'evidence/recorder-multi-final';out.mkdir(exist_ok=True)
mac=platform.system()=='Darwin';display=None
if mac:
 display=subprocess.Popen([str(r/'display-fixture')],env={**os.environ,'SCREENPIPE_ISOLATED_VM_TEST':'1'},stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=(out/'display.log').open('w'),text=True);display.stdout.readline();display.stdin.write('layout 1600 0\n');display.stdin.flush();(out/'topology.json').write_text(display.stdout.readline())
scene=(r if mac else pathlib.Path.home()/'redaction-multi')/'scene.json';scene.write_text(json.dumps({'case':'second_allowed','nonce':time.time()}));time.sleep(2)
env={**os.environ,'RUST_LOG':'screenpipe_engine=debug,screenpipe_screen=info'}
if not mac:env['DISPLAY']=':100'
cmd=[str(r/'source/target/release/screenpipe'),'record','--disable-audio','--disable-telemetry','--data-dir',str(out/'data'),'--port','3051','--video-quality','max','--ignored-windows','PrivacyBlocked','--use-pii-removal=false','--idle-capture-interval-ms','1000','--recording-detail','more_detail']
(out/'command.json').write_text(json.dumps(cmd))
with (out/'recorder.log').open('w') as log:
 p=subprocess.Popen(cmd,env=env,stdout=log,stderr=subprocess.STDOUT)
 try:
  for i in range(60):
   if p.poll() is not None:raise RuntimeError('early exit')
   time.sleep(1)
 finally:
  p.send_signal(signal.SIGINT)
  try:p.wait(timeout=20)
  except subprocess.TimeoutExpired:p.kill();p.wait()
if display:
 display.stdin.write('quit\n');display.stdin.flush();display.wait(timeout=20)
checks=[]
for f in (out/'data').rglob('*.jpg'):
 im=Image.open(f).convert('RGB');px=list(im.getdata());checks.append({'file':f.name,'dimensions':im.size,'marker':sum(a>220 and b<40 and c>220 for a,b,c in px),'allowed':sum(a<40 and b>210 and c>210 for a,b,c in px)})
(out/'pixel-checks.json').write_text(json.dumps(checks))
for db in (out/'data').rglob('index.sqlite'):
 try:
  con=sqlite3.connect(db);rows=con.execute('select device_name,count(*) from frames group by device_name').fetchall();(out/'monitor-counts.json').write_text(json.dumps(rows));print(rows,flush=True)
 except sqlite3.Error:pass
print('images',len(checks),'marker',sum(x['marker'] for x in checks),flush=True)

assert len(checks)>=20 and all(x['marker']==0 and x['allowed']>100 for x in checks)
assert len(rows)==2 and all(count>=10 for name,count in rows)
(out/'acceptance.json').write_text(json.dumps({'passed':True,'monitors':rows,'images':len(checks),'marker_pixels':0,'all_images_useful':True}))
