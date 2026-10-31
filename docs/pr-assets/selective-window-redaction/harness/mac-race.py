# screenpipe — AI that knows everything you've seen, said, or heard
# https://screenpipe.com
import pathlib,subprocess,json,time,os,signal
r=pathlib.Path.home()/'redaction';out=r/'evidence/race-v5';out.mkdir(exist_ok=True);(r/'scene.json').write_text(json.dumps({'case':'five','nonce':time.time()}));time.sleep(1)
p=subprocess.Popen([str(r/'mac-race')],stdout=(out/'fixture.log').open('w'),stderr=subprocess.STDOUT);start=time.time()
try:
 with (out/'probe.jsonl').open('w') as log:res=subprocess.run([str(r/'candidate-probe'),str(out/'capture'),'exclude','0','400','30'],stdout=log,stderr=subprocess.STDOUT,timeout=180)
 (out/'receipt.json').write_text(json.dumps({'exit':res.returncode,'elapsed_s':time.time()-start,'native_popup_tick_ms':50,'frames_attempted':400}))
finally:
 if p.poll() is None:p.terminate();p.wait(timeout=10)
time.sleep(1)
with (out/'recovery.jsonl').open('w') as log:subprocess.run([str(r/'candidate-probe'),str(out/'recovery'),'exclude','0','12','80'],stdout=log,stderr=subprocess.STDOUT,check=True)
