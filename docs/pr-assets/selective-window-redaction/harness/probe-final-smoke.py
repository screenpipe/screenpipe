# screenpipe — AI that knows everything you've seen, said, or heard
# https://screenpipe.com
import pathlib,os,subprocess,platform,json,time,hashlib
r=pathlib.Path.home()/'redaction';out=r/'evidence/probe-final-smoke';out.mkdir(exist_ok=True)
mac=platform.system()=='Darwin';env=dict(os.environ);env['PATH']='/opt/homebrew/bin:'+str(pathlib.Path.home()/'.cargo/bin')+':'+env['PATH']
if not mac:env['DISPLAY']=':99'
source=r/'source/crates/screenpipe-screen/examples/screenshot_redaction_probe.rs'
assert hashlib.sha256(source.read_bytes()).hexdigest()=='07e04cbbecb0aca12aa6e8f89942304e64c695dca48b9606deb076138469d958'
with (out/'build.log').open('w') as log:
 build=subprocess.run(['cargo','build','-p','screenpipe-screen','--release','--example','screenshot_redaction_probe'],cwd=r/'source',env=env,stdout=log,stderr=subprocess.STDOUT)
assert build.returncode==0
(r/'scene.json').write_text(json.dumps({'case':'five','nonce':time.time()}));time.sleep(2)
probe=r/'source/target/release/examples/screenshot_redaction_probe';results=[]
for name,mode,count,tail in [('exclude','exclude','3',[]),('positive','none','1',[]),('invalid','unknown-mode','1',[])]+([] if mac else [('unsupported-cap','exclude','1',['640'])]):
 cmd=[str(probe),str(out/name),mode,'0',count,'100']+tail
 run=subprocess.run(cmd,env=env,capture_output=True,text=True,timeout=45)
 (out/(name+'.log')).write_text(run.stdout+run.stderr)
 rows=[json.loads(l) for l in run.stdout.splitlines() if l.startswith('{')];frames=[v for v in rows if v.get('saved') is True]
 if name=='exclude':passed=run.returncode==0 and len(frames)==3 and all(v['forbidden_pixels']==v['stored_forbidden_pixels']==0 and v['stored_allowed_pixels']>1000 and v['write_ms']>=0 and v['read_ms']>=0 for v in frames)
 elif name=='positive':passed=run.returncode==0 and len(frames)==1 and frames[0]['forbidden_pixels']>1000
 elif name=='invalid':passed=run.returncode!=0 and 'unknown mode' in run.stderr and not frames
 else:passed=run.returncode!=0 and 'MAX_WIDTH is unsupported' in run.stderr and not frames
 results.append({'case':name,'exit':run.returncode,'passed':passed,'frames':len(frames)});assert passed,results[-1]
(out/'acceptance.json').write_text(json.dumps({'probe_sha256':hashlib.sha256(source.read_bytes()).hexdigest(),'runtime_unchanged':True,'build_exit':build.returncode,'binary_sha256':hashlib.sha256(probe.read_bytes()).hexdigest(),'checks':results},indent=2));print(results)
