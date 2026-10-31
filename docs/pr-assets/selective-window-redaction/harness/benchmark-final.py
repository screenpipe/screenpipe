# screenpipe — AI that knows everything you've seen, said, or heard
# https://screenpipe.com
import pathlib,json,subprocess,time,os,platform,statistics
r=pathlib.Path.home()/'redaction';out=r/'evidence/benchmark-final';out.mkdir(exist_ok=True);mac=platform.system()=='Darwin';env={**os.environ};records=[]
if not mac:env['DISPLAY']=':99'
(r/'scene.json').write_text(json.dumps({'case':'five','nonce':time.time()}));time.sleep(1)
probe=r/'candidate-probe' if mac else r/'source/target/release/examples/screenshot_redaction_probe'
for mode,count in [('exclude',620),('none',120)]:
 pth=out/mode;pth.mkdir(exist_ok=True);samples=[];start=time.monotonic()
 with (pth/'frames.jsonl').open('w') as log:
  p=subprocess.Popen([str(probe),str(pth/'capture'),mode,'0',str(count),'100'],env=env,stdout=log,stderr=(pth/'stderr.log').open('w'))
  while p.poll() is None:
   raw=subprocess.run(['ps','-p',str(p.pid),'-o','rss=,pcpu=,time='],capture_output=True,text=True).stdout.strip();fd=None
   if not mac:
    try:fd=len(list(pathlib.Path(f'/proc/{p.pid}/fd').iterdir()))
    except FileNotFoundError:pass
   samples.append({'elapsed_s':time.monotonic()-start,'rss_kb_cpu_percent_cpu_time':raw,'fd_count':fd});(pth/'resources.json').write_text(json.dumps(samples));time.sleep(1)
   if time.monotonic()-start>600:p.kill();p.wait();break
 rows=[json.loads(l) for l in (pth/'frames.jsonl').read_text().splitlines() if l.startswith('{')];frames=[v for v in rows if v.get('saved') is True];timings=sorted(v['capture_ms'] for v in frames[20:]);record={'mode':mode,'exit':p.returncode,'saved':len(frames),'rejected':sum(1 for v in rows if v.get('saved') is False),'warmup':20,'median_ms':statistics.median(timings) if timings else None,'p95_ms':timings[min(len(timings)-1,int(len(timings)*.95))] if timings else None,'wall_s':time.monotonic()-start};records.append(record);(pth/'resources.json').write_text(json.dumps(samples));(out/'summary.json').write_text(json.dumps(records,indent=2));print(record,flush=True)
