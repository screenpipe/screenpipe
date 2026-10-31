# screenpipe — AI that knows everything you've seen, said, or heard
# https://screenpipe.com
import pathlib,subprocess,json,time,os,platform,signal,statistics,shutil
from PIL import Image,ImageChops,ImageStat
r=pathlib.Path.home()/'redaction';out=r/'evidence/final-native';out.mkdir(exist_ok=True);mac=platform.system()=='Darwin';env={**os.environ,'RUST_LOG':'screenpipe_engine=debug,screenpipe_screen=info'}
if not mac:env['DISPLAY']=':99'
probe=r/'source/target/release/examples/screenshot_redaction_probe'
def scene(case):
 (r/'scene.json').write_text(json.dumps({'case':case,'nonce':time.time()}));time.sleep(1)
# Isolated surface test: changing only excluded background must not affect alpha foreground.
for mode in ['none','exclude']:
 for case in ['transparent_front','transparent_front_b']:
  scene(case);p=out/'alpha'/mode/case;p.mkdir(parents=True,exist_ok=True)
  with (p/'probe.jsonl').open('w') as log:subprocess.run([str(probe),str(p/'capture'),mode,'0','8','100'],env=env,stdout=log,stderr=subprocess.STDOUT,check=True,timeout=45)
crop=(1000,570,1200,700) if mac else (1050,550,1250,650);checks=[]
for mode in ['none','exclude']:
 a=Image.open(out/'alpha'/mode/'transparent_front/capture/frame-0.png').convert('RGB').crop(crop);b=Image.open(out/'alpha'/mode/'transparent_front_b/capture/frame-0.png').convert('RGB').crop(crop);diff=ImageChops.difference(a,b);mean=sum(ImageStat.Stat(diff).mean)/3;maximum=max(v[1] for v in diff.getextrema());checks.append({'mode':mode,'crop':crop,'mean_channel_difference':mean,'maximum_channel_difference':maximum,'passed':mean>10 if mode=='none' else maximum<=3})
(out/'alpha-checks.json').write_text(json.dumps(checks,indent=2));print(checks,flush=True)
for policy,extra,cases in [
 ('exclude',[],[('five',30),('excluded_focus',25),('incognito_focus',15),('five',15)]),
 ('include',['--included-windows','PrivacyAllowed'],[('excluded_focus',25)]),
 ('url-gate',['--ignored-urls','private.example'],[('excluded_focus',25)]),
 ('drm-gate',['--pause-on-drm-content'],[('excluded_focus',25)])]:
 pth=out/policy;pth.mkdir(exist_ok=True);records=[];samples=[];scene(cases[0][0]);cmd=[str(r/'source/target/release/screenpipe'),'record','--disable-audio','--disable-telemetry','--data-dir',str(pth/'data'),'--port','3051','--video-quality','max','--ignored-windows','PrivacyBlocked','--use-pii-removal=false','--idle-capture-interval-ms','1000','--recording-detail','more_detail']+extra
 video=None
 if policy=='exclude':
  video_cmd=(['/opt/homebrew/bin/ffmpeg','-loglevel','warning','-y','-f','avfoundation','-framerate','8','-i','0:none'] if mac else ['/usr/bin/ffmpeg','-loglevel','warning','-y','-f','x11grab','-framerate','8','-video_size','1920x1080','-i',':99'])+['-t','150','-c:v','libx264','-preset','ultrafast','-crf','24','-pix_fmt','yuv420p',str(pth/'native-session.mp4')]
  video_started=time.time();video=subprocess.Popen(video_cmd,stdin=subprocess.PIPE,stderr=(pth/'video.log').open('w'),env=env)
  (pth/'video-receipt.json').write_text(json.dumps({'started_at':video_started,'command':video_cmd}))
 (pth/'command.json').write_text(json.dumps(cmd))
 with (pth/'recorder.log').open('w') as log:
  proc=subprocess.Popen(cmd,env=env,stdout=log,stderr=subprocess.STDOUT)
  try:
   for case,seconds in cases:
    scene(case);start=time.time()
    while time.time()-start<seconds:
     if proc.poll() is not None:raise RuntimeError('recorder exited '+str(proc.returncode))
     samples.append({'time':time.time(),'case':case,'proc':subprocess.check_output(['ps','-p',str(proc.pid),'-o','etime=,pcpu=,rss='],text=True).strip()});time.sleep(1)
    files=[str(f.relative_to(pth)) for f in (pth/'data').rglob('*.jpg') if start+2<=f.stat().st_mtime<=time.time()];records.append({'case':case,'start':start+2,'end':time.time(),'snapshot_count':len(files),'snapshots':files});(pth/'receipt.json').write_text(json.dumps(records,indent=2));print(policy,case,len(files),flush=True)
    if files:shutil.copy2(pth/files[-1],pth/(case+'-saved.jpg'))
    shot=['/usr/sbin/screencapture','-x',str(pth/(case+'-desktop.png'))] if mac else ['/usr/bin/ffmpeg','-loglevel','error','-y','-f','x11grab','-video_size','1920x1080','-i',':99','-frames:v','1',str(pth/(case+'-desktop.png'))]
    subprocess.run(shot,env=env,check=True)
  finally:
   if proc.poll() is None:proc.send_signal(signal.SIGINT)
   try:proc.wait(timeout=20)
   except subprocess.TimeoutExpired:proc.kill();proc.wait()
   (pth/'exit.json').write_text(json.dumps({'exit':proc.returncode}));(pth/'process-samples.json').write_text(json.dumps(samples))
   if video and video.poll() is None:video.communicate(b'q',timeout=20)
 subprocess.run([str(pathlib.Path(os.sys.executable)),str(r/'verify-recorder-final.py'),str(pth)],check=True,env=env)
 checks=json.loads((pth/'pixel-checks.json').read_text());dbrows=[f for db in json.loads((pth/'database-checks.json').read_text()) for f in db['frames']];assertions=[]
 for row in checks:
  should_save=policy in ['exclude','include'] and row['case']!='incognito_focus'
  assertions.append({'case':row['case'],'check':'expected persistence','passed':len(row['images'])>=5 if should_save else len(row['images'])==0})
  if should_save:
   assertions.append({'case':row['case'],'check':'allowed pixels retained; excluded absent','passed':row['useful'] and row['no_forbidden_pixels']})
  if should_save and row['case']=='excluded_focus':
   names={pathlib.Path(f).name for f in row['snapshots']};selected=[f for f in dbrows if pathlib.Path(f.get('snapshot_path') or '').name in names];fields=['app_name','window_name','browser_url','accessibility_text','accessibility_tree_json','full_text','elements_ref_frame_id','document_path','text_json'];assertions.append({'case':row['case'],'check':'no excluded metadata, text or reused elements','rows':len(selected),'passed':len(selected)>=5 and all(all(f.get(k) in [None,'','[]'] for k in fields) and not f.get('focused') for f in selected)})
 (pth/'acceptance.json').write_text(json.dumps(assertions,indent=2));print(policy,assertions,flush=True)
scene('five')
