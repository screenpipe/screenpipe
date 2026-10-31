# screenpipe — AI that knows everything you've seen, said, or heard
# https://screenpipe.com
import pathlib,json,subprocess,time,os,platform,statistics
r=pathlib.Path.home()/'redaction';out=r/'evidence/benchmark-clean';out.mkdir(exist_ok=True);env={**os.environ};records=[]
if platform.system()!='Darwin':env['DISPLAY']=':99'
(r/'scene.json').write_text(json.dumps({'case':'five','nonce':time.time()}));time.sleep(2)
for label,probe in [('baseline',r/'baseline-soak-probe'),('candidate',r/'source/target/release/examples/screenshot_redaction_probe')]:
 pth=out/label;pth.mkdir(exist_ok=True);samples=[];start=time.monotonic()
 with (pth/'frames.jsonl').open('w') as log:
  proc=subprocess.Popen([str(probe),str(pth/'capture'),'exclude','0','140','100'],env=env,stdout=log,stderr=(pth/'stderr.log').open('w'))
  while proc.poll() is None:
   samples.append({'elapsed_s':time.monotonic()-start,'rss_kb_cpu_percent_cpu_time':subprocess.run(['ps','-p',str(proc.pid),'-o','rss=,pcpu=,time='],capture_output=True,text=True).stdout.strip()});time.sleep(.5)
   if time.monotonic()-start>120:proc.kill();proc.wait();raise RuntimeError('benchmark timeout')
 rows=[json.loads(l) for l in (pth/'frames.jsonl').read_text().splitlines() if l.startswith('{')];frames=[v for v in rows if v.get('saved') is True];timings=sorted(v['capture_ms'] for v in frames[20:]);record={'variant':label,'exit':proc.returncode,'saved':len(frames),'rejected':sum(v.get('saved') is False for v in rows),'marker_pixels':sum(v.get('forbidden_pixels',0)+v.get('stored_forbidden_pixels',0) for v in frames),'warmup':20,'measured_frames':len(timings),'median_ms':statistics.median(timings) if timings else None,'p95_ms':timings[min(len(timings)-1,int(len(timings)*.95))] if timings else None,'wall_s':time.monotonic()-start};records.append(record);(pth/'resources.json').write_text(json.dumps(samples));(out/'summary.json').write_text(json.dumps(records,indent=2));print(record,flush=True)
 assert record['exit']==0 and record['saved']==140 and not record['rejected'] and not record['marker_pixels']
