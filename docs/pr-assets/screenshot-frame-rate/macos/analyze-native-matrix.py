# screenpipe — AI that knows everything you've seen, said, or heard
# https://screenpipe.com
import json, sys, statistics
from pathlib import Path
root=Path(sys.argv[1]); trials=[]
for line in (root/'summary.jsonl').read_text().splitlines():
    entry=json.loads(line); label=entry['label']; results=[r for r in entry['results'] if r.get('phase')=='result']; ready=next((r for r in entry['results'] if r.get('phase')=='ready'),None)
    if len(results)!=1 or entry['exit']!=0:
        trials.append({'label':label,'exit':entry['exit'],'results':entry['results'],'stderr':entry['stderr'],'valid':False});continue
    result=results[0]; samples=json.loads((root/(label+'-processes.json')).read_text()); steady=[s for s in samples if ready['ready_epoch']<=s['at']<=result['end_epoch']]
    overlap=any(sum(any(name in p['name'] for name in ['RateBench','RateDemandBench']) for p in s['processes'].values())>1 for s in steady)
    row={'label':label,'valid':not overlap,'invalid_reason':'overlapping benchmark processes' if overlap else None,**result}
    for name in ['WindowServer','replayd']:
        if len(steady)<2:continue
        first,last=steady[0],steady[-1]; secs=last['at']-first['at']; total=0.0
        for pid,p in last['processes'].items():
            if name in p['name'] and pid in first['processes']:total+=p['cpu']-first['processes'][pid]['cpu']
        row[name+'_cpu_percent_one_core']=100*total/secs
        row[name+'_peak_rss_bytes']=max(sum(p['rss_kib']*1024 for p in s['processes'].values() if name in p['name']) for s in steady)
    row['selection_per_second']=result['saved']/result['seconds'];row['failed_requests']=0;trials.append(row)
groups={}
for r in trials:
    if not r['valid']:continue
    key=(r['mode'],r['producer_fps'] if r['mode'].startswith('stream') else 0,r['dynamic']);groups.setdefault(key,[]).append(r)
metrics=['seconds','saved','selection_per_second','delivered_fps','cpu_percent','peak_rss_bytes','capture_p95_ms','total_p95_ms','setup_ms','stream_first_frame_ms','stop_ms','missed_deadlines','WindowServer_cpu_percent_one_core','replayd_cpu_percent_one_core']
aggregate=[{'mode':k[0],'requested_fps':k[1],'dynamic':k[2],'trials':len(rs),**{m:statistics.mean(r[m] for r in rs if m in r) for m in metrics if any(m in r for r in rs)}} for k,rs in groups.items()]
report={'cpu_units':'percent of one logical CPU core','source_boundary':'native ScreenCaptureKit positive filter + JPEG encoding, no AX/OCR/disk writes','excluded_trials':[{'label':r['label'],'reason':r.get('invalid_reason',r.get('stderr'))} for r in trials if not r['valid']],'trials':trials,'aggregate':aggregate}
(root/'analysis.json').write_text(json.dumps(report,indent=2));print(json.dumps(aggregate,indent=2))
