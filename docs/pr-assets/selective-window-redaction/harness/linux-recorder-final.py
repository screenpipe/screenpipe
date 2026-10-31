# screenpipe — AI that knows everything you've seen, said, or heard
# https://screenpipe.com
import pathlib,subprocess,os,json,time,signal,urllib.request
r=pathlib.Path.home()/'redaction';out=r/'evidence/recorder-v3';out.mkdir(exist_ok=True)
cmd=[str(r/'source/target/release/screenpipe'),'record','--disable-audio','--disable-telemetry','--data-dir',str(out/'data'),'--port','3051','--video-quality','max','--ignored-windows','PrivacyBlocked','--use-pii-removal=false','--idle-capture-interval-ms','1000','--recording-detail','more_detail']
(out/'command.json').write_text(json.dumps(cmd));samples=[];records=[]
with (out/'recorder.log').open('w') as log:
 p=subprocess.Popen(cmd,env={**os.environ,'DISPLAY':':99','RUST_LOG':'screenpipe_engine=debug,screenpipe_screen=info'},stdout=log,stderr=subprocess.STDOUT)
 try:
  for case,secs in [('five',30),('small',20),('five',45)]:
   (r/'scene.json').write_text(json.dumps({'case':case,'nonce':time.time()}));start=time.time()
   while time.time()-start<secs:
    if p.poll() is not None:raise RuntimeError('recorder exited '+str(p.returncode))
    samples.append({'time':time.time(),'case':case,'proc':subprocess.check_output(['ps','-p',str(p.pid),'-o','etimes=,pcpu=,rss=,nlwp='],text=True).strip()});time.sleep(1)
   files=[str(f.relative_to(out)) for f in (out/'data').rglob('*.jpg') if start<=f.stat().st_mtime<=time.time()];records.append({'case':case,'start':start,'end':time.time(),'snapshot_count':len(files),'snapshots':files});(out/'receipt.json').write_text(json.dumps(records,indent=2));print(case,len(files),flush=True)
  try:
   with urllib.request.urlopen('http://127.0.0.1:3051/health',timeout=5) as h:(out/'health.json').write_bytes(h.read())
  except Exception as e:(out/'health-error.txt').write_text(str(e))
 finally:
  if p.poll() is None:p.send_signal(signal.SIGINT)
  try:p.wait(timeout=20)
  except subprocess.TimeoutExpired:p.kill();p.wait()
  (out/'exit.json').write_text(json.dumps({'exit':p.returncode}));(out/'process-samples.json').write_text(json.dumps(samples))
