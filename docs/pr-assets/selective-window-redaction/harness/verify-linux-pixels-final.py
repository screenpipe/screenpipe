# screenpipe — AI that knows everything you've seen, said, or heard
# https://screenpipe.com
from pathlib import Path
import json
from PIL import Image
r=Path('outputs/redaction-validation/linux/cases-v4');rows=[]
def pixel(case,xy):return Image.open(r/case/'capture/frame-0.png').convert('RGB').getpixel(xy)
checks=[('five-exclude',(100,100),(0,255,255)),('five-exclude',(700,100),(0,255,255)),('five-exclude',(1300,100),(0,255,255)),('five-exclude',(250,600),(0,255,255)),('five-exclude',(1100,600),(0,0,0)),('excluded_front-exclude',(1000,600),(0,0,0)),('excluded_behind-exclude',(1000,600),(0,255,255)),('transparent_front-exclude',(1000,600),(0,140,140)),('small-exclude',(80,100),(0,255,255)),('fully_occluded-exclude',(1100,600),(0,255,255))]
for case,point,expected in checks:
 actual=pixel(case,point);rows.append({'case':case,'point':point,'expected':expected,'actual':actual,'passed':max(abs(a-b) for a,b in zip(actual,expected))<=1})
for p in r.glob('*-*/capture/frame-0.png'):
 im=Image.open(p).convert('RGB');rows.append({'case':p.parents[1].name,'check':'full display dimensions','passed':im.size==(1920,1080)})
for case in ['five-exclude','no_excluded-exclude','minimized-exclude','all_excluded-exclude']:
 im=Image.open(r/case/'capture/frame-0.png').convert('RGB');desktop=Image.open(r/case/'desktop.png').convert('RGB');rows.append({'case':case,'check':'wallpaper preserved','passed':im.getpixel((10,1000))==desktop.getpixel((10,1000))})
blank=Image.open(r/'five-empty/capture/frame-0.png').convert('RGB');rows.append({'case':'empty include','check':'no unselected pixels','passed':all(v==(0,0) for v in blank.getextrema())})
(r/'pixel-assertions.json').write_text(json.dumps(rows,indent=2));print(json.dumps({'passed':sum(x['passed'] for x in rows),'total':len(rows),'failures':[x for x in rows if not x['passed']]},indent=2))
assert all(x['passed'] for x in rows)
