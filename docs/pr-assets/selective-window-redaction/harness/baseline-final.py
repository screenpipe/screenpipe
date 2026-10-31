# screenpipe — AI that knows everything you've seen, said, or heard
# https://screenpipe.com
import pathlib,json,subprocess,time,os,platform,statistics
r=pathlib.Path.home()/'redaction';out=r/'evidence/baseline-final';out.mkdir(exist_ok=True);env={**os.environ};rows=[]
if platform.system()!='Darwin':env['DISPLAY']=':99'
(r/'scene.json').write_text(json.dumps({'case':'five','nonce':time.time()}));time.sleep(1)
for mode in ['exclude','none']:
 for n in range(3):
  dest=out/(mode+'-'+str(n));dest.mkdir(exist_ok=True)
  with (dest/'probe.jsonl').open('w') as log:p=subprocess.run([str(r/'baseline-probe'),str(dest/'capture'),'0',mode],env=env,stdout=log,stderr=subprocess.STDOUT,timeout=120)
  frames=[json.loads(l) for l in (dest/'probe.jsonl').read_text().splitlines() if l.startswith('{')];times=[x['capture_ms'] for x in frames if 'capture_ms' in x];row={'mode':mode,'run':n,'exit':p.returncode,'frames':len(times),'median_ms':statistics.median(times) if times else None,'p95_ms':sorted(times)[-1] if times else None};rows.append(row);print(row,flush=True);(out/'summary.json').write_text(json.dumps(rows,indent=2))
