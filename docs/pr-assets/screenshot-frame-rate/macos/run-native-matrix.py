# screenpipe — AI that knows everything you've seen, said, or heard
# https://screenpipe.com
import subprocess,time,json
from pathlib import Path
base=Path('/Users/admin/persistent-capture');out=base/'native-final-hybrid';out.mkdir(exist_ok=True)
rates=[1,2,4,8,12,24,30]
def sample():
 rows={}
 for line in subprocess.check_output(['/bin/ps','-axo','pid=,time=,rss=,comm='],text=True).splitlines():
  s=line.split(None,3)
  if len(s)!=4:continue
  pid,t,rss,name=s
  if any(x in name for x in ['WindowServer','replayd','RateDemandBench']):
   rows[pid]={'name':name,'cpu':sum(float(v)*60**i for i,v in enumerate(reversed(t.split(':')))),'rss_kib':int(rss)}
 return rows
with (out/'summary.jsonl').open('w') as summary:
 for round in range(1):
  for scene in ['static','dynamic']:
   conditions=[('screenshot',0)]+[('streamondemand',r) for r in (rates if round==0 else rates[::-1])]
   for mode,fps in conditions:
    label=f'{round}-{scene}-{mode}-{fps}';path=out/(label+'.jsonl')
    samples=[]
    with path.open('w') as f:
     proc=subprocess.Popen(['/Applications/ScreenpipeRateDemandBench.app/Contents/MacOS/RateDemandBench',mode,'4','30',scene,'jitter',str(fps or 4)],stdout=f,stderr=subprocess.PIPE,text=True)
     while proc.poll() is None:
      samples.append({'at':time.time(),'processes':sample()});time.sleep(1)
     err=proc.stderr.read()
    (out/(label+'-processes.json')).write_text(json.dumps(samples))
    results=[json.loads(x) for x in path.read_text().splitlines() if x.startswith('{')]
    record={'label':label,'exit':proc.returncode,'stderr':err,'results':results}
    summary.write(json.dumps(record)+'\n');summary.flush();print(label,proc.returncode,flush=True)
