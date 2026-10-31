# screenpipe — AI that knows everything you've seen, said, or heard
# https://screenpipe.com
import pathlib,subprocess,time,json,os
r=pathlib.Path.home()/'redaction';out=r/'evidence/retina-v5-cap';out.mkdir(exist_ok=True);rows=[]
p=subprocess.Popen([str(r/'display-fixture')],env={**os.environ,'SCREENPIPE_ISOLATED_VM_TEST':'1'},stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=(out/'fixture.log').open('w'),text=True)
def command(c=None):
 if c:p.stdin.write(c+'\n');p.stdin.flush()
 t=json.loads(p.stdout.readline());(out/'topologies.jsonl').open('a').write(json.dumps({'command':c,'topology':t})+'\n');return t
try:
 t=command();t=command('layout 1600 0')
 for layout,cases in [('retina',['secondary','second_allowed'])]:
  if layout=='negative':t=command('layout -1280 0')
  if layout=='retina':
   t=command('add-retina');t=command('layout 1600 0')
   assert any(d['pixels_w']==2*d['w'] for d in t['displays']), 'HiDPI mode did not activate'
  for case in cases:
   start=time.time();(r/'scene.json').write_text(json.dumps({'case':case,'nonce':start}));time.sleep(1.5)
   applied=json.loads((r/'scene-applied.json').read_text());assert applied['case']==case and applied['time']>=start, 'fixture did not apply scene'
   (out/(layout+'-'+case+'-fixture.json')).write_text(json.dumps(applied))
   for d in t['displays']:
    dest=out/(layout+'-'+case+'-'+str(d['id']));dest.mkdir(exist_ok=True)
    with (dest/'probe.jsonl').open('w') as log:res=subprocess.run([str(r/'candidate-probe'),str(dest/'capture'),'exclude',str(d['id']),'8','80','1280'],stdout=log,stderr=subprocess.STDOUT,timeout=90)
    result=[json.loads(l) for l in (dest/'probe.jsonl').read_text().splitlines() if l.startswith('{')];assert all((x['width'],x['height'])==(min(1280,d['pixels_w']),max(1,d['pixels_h']*min(1280,d['pixels_w'])//d['pixels_w'])) for x in result if x.get('saved') is True), 'native pixel dimensions lost';summary=next((x for x in result if x.get('summary')),{});row={'layout':layout,'case':case,'monitor':d,'exit':res.returncode,**summary};rows.append(row);print(row,flush=True);(out/'receipt.json').write_text(json.dumps(rows,indent=2))
finally:
 p.stdin.write('quit\n');p.stdin.flush();p.wait(timeout=20)
 subprocess.run([str(r/'display-fixture'),'--list-only'],env={**os.environ,'SCREENPIPE_ISOLATED_VM_TEST':'1'},stdout=(out/'cleanup.json').open('w'),check=True)
