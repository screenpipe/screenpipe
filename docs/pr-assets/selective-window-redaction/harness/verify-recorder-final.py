# screenpipe — AI that knows everything you've seen, said, or heard
# https://screenpipe.com
import pathlib,json,sys,sqlite3,hashlib,subprocess,os,tempfile,shutil
from PIL import Image
out=pathlib.Path(sys.argv[1]);base=pathlib.Path.home()/'redaction';records=[]
for row in json.loads((out/'receipt.json').read_text()):
 images=[]
 for name in row['snapshots']:
  p=out/name;im=Image.open(p).convert('RGB');pixels=list(im.getdata());bad=sum(r>200 and g<60 and b>200 for r,g,b in pixels);cyan=sum(r<60 and g>200 and b>200 for r,g,b in pixels);yellow=sum(r>200 and g>200 and b<60 for r,g,b in pixels)
  images.append({'file':name,'dimensions':im.size,'forbidden_pixels':bad,'cyan_pixels':cyan,'yellow_pixels':yellow})
 row={**row,'images':images};row['no_forbidden_pixels']=all(x['forbidden_pixels']==0 for x in images);row['useful']=all(((x['cyan_pixels']+x['yellow_pixels']) if row['case']=='race' else x['yellow_pixels'] if row['case']=='same_app' else x['cyan_pixels'])>100 for x in images) if images else row['case']=='excluded_focus';records.append(row)
(out/'pixel-checks.json').write_text(json.dumps(records,indent=2))
print(json.dumps([{'case':x['case'],'images':len(x['images']),'no_forbidden_pixels':x['no_forbidden_pixels'],'useful':x['useful'],'sizes':sorted(set(tuple(i['dimensions']) for i in x['images']))} for x in records]))
rows=[]
for db in (out/'data'/'storage').rglob('index.sqlite'):
 scratch=tempfile.TemporaryDirectory(prefix='screenpipe-index-inspect-');copy=pathlib.Path(scratch.name)/'index.sqlite'
 for suffix in ['', '-wal', '-shm']:
  source=pathlib.Path(str(db)+suffix)
  if source.exists():
   dest=pathlib.Path(str(copy)+suffix);shutil.copy2(source,dest);dest.chmod(0o600)
 c=sqlite3.connect(copy);c.execute('PRAGMA query_only=ON');c.create_function('screenpipe_payload_sha256',1,lambda x:hashlib.sha256(x.encode() if isinstance(x,str) else x or b'').digest(),deterministic=True)
 cols=[r[1] for r in c.execute('PRAGMA table_info(frames)')];selected=[k for k in ['id','timestamp','app_name','window_name','browser_url','file_path','snapshot_path','text_source','focused','accessibility_text','accessibility_tree_json','full_text','elements_ref_frame_id','document_path','text_json'] if k in cols]
 data=[dict(zip(selected,row)) for row in c.execute('SELECT '+','.join(selected)+' FROM frames ORDER BY id')]
 try: integrity=c.execute('PRAGMA integrity_check').fetchall()
 except sqlite3.OperationalError as e: integrity={'unsupported_external_sqlite_function':str(e)}
 rows.append({'database':str(db.relative_to(out)),'integrity':integrity,'columns':cols,'frames':data});c.close();scratch.cleanup()
(out/'database-checks.json').write_text(json.dumps(rows,indent=2));print(json.dumps([{'database':x['database'],'integrity':x['integrity'],'frames':len(x['frames'])} for x in rows]))
r=subprocess.run([str(base/'source/target/release/screenpipe'),'db','check'],env={**os.environ,'SCREENPIPE_DATA_DIR':str(out/'data')},text=True,capture_output=True,timeout=60)
(out/'production-db-check.json').write_text(json.dumps({'exit_code':r.returncode,'stdout':r.stdout,'stderr':r.stderr}));print('production db check',r.returncode)
