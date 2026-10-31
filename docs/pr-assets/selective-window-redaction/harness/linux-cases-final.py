# screenpipe — AI that knows everything you've seen, said, or heard
# https://screenpipe.com
import pathlib,json,subprocess,time,os
r=pathlib.Path.home()/'redaction';out=r/'evidence/cases-v3';out.mkdir(exist_ok=True);env={**os.environ,'DISPLAY':':99'}
probe=r/'source/target/release/examples/screenshot_redaction_probe';records=[]
v=subprocess.Popen(['ffmpeg','-loglevel','warning','-y','-f','x11grab','-framerate','8','-video_size','1920x1080','-i',':99','-t','180','-c:v','libx264','-preset','ultrafast','-crf','24','-pix_fmt','yuv420p',str(out/'native-session.mp4')],stdin=subprocess.PIPE,stderr=(out/'video.log').open('w'))
cases=[('five','none'),('five','exclude'),('five','include'),('five','empty'),('no_excluded','exclude'),('no_excluded','nomatch'),('minimized','exclude'),('offscreen','exclude'),('excluded_front','exclude'),('excluded_behind','exclude'),('transparent_front','exclude'),('small','exclude'),('blank_title','exclude'),('all_excluded','exclude'),('spanning','exclude'),('fully_occluded','exclude')]
video_start=time.monotonic()
try:
 for case,mode in cases:
  case_start=time.monotonic()-video_start;p=out/(case+'-'+mode);p.mkdir(exist_ok=True);(r/'scene.json').write_text(json.dumps({'case':case,'nonce':time.time()}));time.sleep(1)
  subprocess.run(['ffmpeg','-loglevel','error','-y','-f','x11grab','-video_size','1920x1080','-i',':99','-frames:v','1',str(p/'desktop.png')],env=env,check=True)
  with (p/'probe.jsonl').open('w') as log:res=subprocess.run([str(probe),str(p/'capture'),mode,'0','12','50'],env=env,stdout=log,stderr=subprocess.STDOUT,timeout=60)
  lines=[json.loads(l) for l in (p/'probe.jsonl').read_text().splitlines() if l.startswith('{')];summ=next((l for l in lines if l.get('summary')), {})
  row={'session_time_s':case_start,'case':case,'mode':mode,'exit':res.returncode,**summ};records.append(row);(out/'receipt.json').write_text(json.dumps(records,indent=2));print(json.dumps(row),flush=True)
finally:
 if v.poll() is None:v.stdin.write(b'q\n');v.stdin.flush()
 v.wait(timeout=20)
