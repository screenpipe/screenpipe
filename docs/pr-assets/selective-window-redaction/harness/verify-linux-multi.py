# screenpipe — AI that knows everything you've seen, said, or heard
# https://screenpipe.com
from pathlib import Path
from PIL import Image
import json
r=Path('outputs/redaction-validation/linux/multi');rows=[]
def im(case,id):return Image.open(r/(case+'-'+str(id))/'capture/frame-0.png').convert('RGB')
for c in ['five','secondary','spanning','second_allowed']:
 for id in [78,79]:rows.append({'case':c,'monitor':id,'check':'full monitor dimensions','passed':im(c,id).size==(1920,1080)})
for c,id,pt,want in [('five',78,(1100,600),(0,0,0)),('secondary',79,(500,300),(0,0,0)),('spanning',78,(1800,300),(0,0,0)),('spanning',79,(100,300),(0,0,0)),('second_allowed',79,(500,300),(0,255,255))]:
 actual=im(c,id).getpixel(pt);rows.append({'case':c,'monitor':id,'point':pt,'actual':actual,'passed':actual==want})
rows.append({'check':'untouched first-monitor allowed window survives right-monitor exclusion','passed':im('five',78).getpixel((700,100))==im('secondary',78).getpixel((700,100))==(0,255,255)})
(r/'pixel-assertions.json').write_text(json.dumps(rows,indent=2));print(json.dumps({'passed':sum(x['passed'] for x in rows),'total':len(rows),'failed':[x for x in rows if not x['passed']]},indent=2));assert all(x['passed'] for x in rows)
