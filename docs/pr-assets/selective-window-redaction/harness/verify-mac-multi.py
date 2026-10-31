# screenpipe — AI that knows everything you've seen, said, or heard
# https://screenpipe.com
from pathlib import Path
from PIL import Image
import json
root=Path('outputs/redaction-validation/macos');checks=[]
for name in ['multi-v4-verified','retina-v5-verified','retina-v5-cap']:
 r=root/name
 if not r.exists():continue
 for row in json.loads((r/'receipt.json').read_text()):
  d=row['monitor'];p=r/(row['layout']+'-'+row['case']+'-'+str(d['id']))/'capture/frame-0.png';im=Image.open(p).convert('RGB');cap=1280 if name.endswith('-cap') else d['pixels_w'];w=min(cap,d['pixels_w']);h=max(1,d['pixels_h']*w//d['pixels_w']);checks.append({'suite':name,'case':row['case'],'monitor':d['id'],'check':'native pixels or explicit cap','actual':im.size,'expected':[w,h],'pass':im.size==(w,h)})
  if not d['main'] and row['case'] in ['secondary','second_allowed']:
   # Native AppKit fixture positions are logical coordinates from screen bottom.
   point=(400,350 if row['case']=='secondary' else 200);xy=(round(point[0]*w/d['w']),round(point[1]*h/d['h']));actual=im.getpixel(xy);want=(0,0,0) if row['case']=='secondary' else (0,255,255);checks.append({'suite':name,'case':row['case'],'monitor':d['id'],'point':xy,'actual':actual,'expected':want,'pass':actual==want})
(root/'multi-pixel-assertions.json').write_text(json.dumps(checks,indent=2));print(json.dumps({'passed':sum(x['pass'] for x in checks),'total':len(checks),'failed':[x for x in checks if not x['pass']]},indent=2));assert all(x['pass'] for x in checks)
