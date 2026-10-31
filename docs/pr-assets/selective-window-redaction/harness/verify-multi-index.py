# screenpipe — AI that knows everything you've seen, said, or heard
# https://screenpipe.com
import pathlib,json,sqlite3,subprocess,os,shutil,hashlib
r=pathlib.Path.home()/'redaction';out=r/'evidence/recorder-multi-final';rows=[]
for db in (out/'data').rglob('index.sqlite'):
 con=sqlite3.connect(db);rows.extend(con.execute('select device_name,count(*) from frames group by device_name').fetchall());con.close()
checks=json.loads((out/'pixel-checks.json').read_text());assert len(checks)>=20 and all(x['marker']==0 and x['allowed']>100 for x in checks);assert len(rows)==2 and all(n>=10 for _,n in rows)
for device,count in rows:
 candidates=sorted((out/'data').rglob('*_m'+device.rsplit('_',1)[-1]+'.jpg'))
 if candidates:shutil.copy2(candidates[-1],out/(device.replace(' ','-')+'-saved.jpg'))
p=subprocess.run([str(r/'source/target/release/screenpipe'),'db','check'],env={**os.environ,'SCREENPIPE_DATA_DIR':str(out/'data')},capture_output=True,text=True,timeout=60);assert p.returncode==0
(out/'production-db-check.json').write_text(json.dumps({'exit_code':p.returncode,'stdout':p.stdout,'stderr':p.stderr}));(out/'acceptance.json').write_text(json.dumps({'passed':True,'monitors':rows,'images':len(checks),'marker_pixels':0,'all_images_useful':True,'engine_source_sha256':hashlib.sha256((r/'source/crates/screenpipe-engine/src/event_driven_capture.rs').read_bytes()).hexdigest()},indent=2));print(rows)
