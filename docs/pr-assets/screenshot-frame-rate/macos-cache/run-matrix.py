# screenpipe — AI that knows everything you've seen, said, or heard
# https://screenpipe.com
import subprocess,time,json,statistics,math
from pathlib import Path
base=Path('/Users/admin/cached-scene');out=base/'cache-matrix';out.mkdir(exist_ok=True)
probe='/Applications/ScreenpipeCacheProbe.app/Contents/MacOS/screenshot_redaction_probe'
def ps_sample():
    rows={}
    for line in subprocess.check_output(['/bin/ps','-axo','pid=,time=,rss=,comm='],text=True).splitlines():
        parts=line.split(None,3)
        if len(parts)!=4: continue
        pid,clock,rss,name=parts
        if not any(s in name for s in ['WindowServer','replayd','screenshot_redaction_probe']): continue
        rows[pid]={'name':name,'cpu_seconds':sum(float(v)*60**i for i,v in enumerate(reversed(clock.split(':')))),'rss_kib':int(rss)}
    return rows
def quantile(values,q):
    values=sorted(values)
    return values[min(len(values)-1, math.ceil(len(values)*q)-1)] if values else None
conditions=[('dynamic',r) for r in [1,2,4,8,12,24,30]]+[('static',r) for r in [2,24,30]]
summary=[]
for scene,fps in conditions:
    page=base/('rate-motion.html' if scene=='dynamic' else 'rate-static.html')
    subprocess.run(['/usr/bin/open','-a','Safari',str(page)],check=True)
    time.sleep(2)
    label=f'{scene}-{fps}';directory=out/label;directory.mkdir(exist_ok=True)
    samples=[];began=time.monotonic()
    with (directory/'requests.jsonl').open('w') as stdout,(directory/'native.log').open('w') as stderr:
        proc=subprocess.Popen([probe,str(directory),'none','0','120','250','1024',str(fps)],stdout=stdout,stderr=stderr,env={**__import__('os').environ,'RUST_LOG':'info'})
        while proc.poll() is None:
            samples.append({'at':time.monotonic()-began,'processes':ps_sample()});time.sleep(0.5)
    elapsed=time.monotonic()-began
    (directory/'processes.json').write_text(json.dumps(samples))
    rows=[json.loads(l) for l in (directory/'requests.jsonl').read_text().splitlines() if l.startswith('{')]
    requests=[r for r in rows if not r.get('summary')];good=[r for r in requests if r.get('saved')]
    warm=good[1:]
    cpu={}
    for needle in ['WindowServer','replayd','screenshot_redaction_probe']:
        observed={}
        for sample in samples:
            for pid,value in sample['processes'].items():
                if needle in value['name']: observed.setdefault(pid,[]).append((sample['at'],value))
        cpu[needle]={'one_core_percent':sum((v[-1][1]['cpu_seconds']-v[0][1]['cpu_seconds'])/(v[-1][0]-v[0][0])*100 for v in observed.values() if len(v)>1 and v[-1][0]>v[0][0]),'peak_rss_mib':max((r[1]['rss_kib']/1024 for v in observed.values() for r in v),default=0)}
    row={'scene':scene,'fps':fps,'exit_code':proc.returncode,'requests':len(requests),'saved':len(good),'failed':len(requests)-len(good),'elapsed_seconds':elapsed,'cold_capture_ms':good[0]['capture_ms'] if good else None,'warm_capture_p50_ms':quantile([r['capture_ms'] for r in warm],.5),'warm_capture_p95_ms':quantile([r['capture_ms'] for r in warm],.95),'frame_age_p50_ms':quantile([r['cache_age_ms'] for r in warm if r['cache_age_ms'] is not None],.5),'frame_age_p95_ms':quantile([r['cache_age_ms'] for r in warm if r['cache_age_ms'] is not None],.95),'pre_request_frames':sum(r['cache_age_ms']>=0 for r in warm if r['cache_age_ms'] is not None),'native_timestamp_frames':sum(r['native_timestamp'] for r in good),'distinct_frame_times':len(set(r['captured_at'] for r in good)),'cpu':cpu}
    if len(good)>1 and good[0].get('native_sequence') is not None and good[-1].get('native_sequence') is not None:
        # Request starts are scheduled at 4/s. Report callback rate separately
        # from useful pixel-change rate and from saved screenshots.
        from datetime import datetime
        delta=(datetime.fromisoformat(good[-1]['requested_at'].replace('Z','+00:00'))-datetime.fromisoformat(good[0]['requested_at'].replace('Z','+00:00'))).total_seconds()
        row['native_callbacks_per_second']=(good[-1]['native_sequence']-good[0]['native_sequence'])/delta
    summary.append(row);(out/'summary.json').write_text(json.dumps(summary,indent=2));print(json.dumps(row),flush=True)
    if proc.returncode or len(good)!=120: raise SystemExit('production capture probe failed: '+label)
