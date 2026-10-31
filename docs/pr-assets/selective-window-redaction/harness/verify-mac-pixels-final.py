# screenpipe — AI that knows everything you've seen, said, or heard
# https://screenpipe.com
from pathlib import Path
from PIL import Image, ImageChops, ImageStat
import json
r=Path('outputs/redaction-validation/macos/cases-v5');rows=[]
def im(case):return Image.open(r/case/'capture/frame-0.png').convert('RGB')
for case,pt,want in [('five-exclude',(100,200),(0,255,255)),('five-exclude',(600,200),(0,255,255)),('five-exclude',(1200,200),(0,255,255)),('five-exclude',(200,600),(0,255,255)),('five-exclude',(1000,600),(0,0,0)),('five-include',(100,200),(0,255,255)),('five-include',(600,200),(0,255,255)),('five-include',(1200,200),(0,255,255)),('five-include',(200,600),(0,255,255)),('excluded_front-exclude',(1000,600),(0,0,0)),('excluded_behind-exclude',(1000,600),(0,255,255)),('transparent_front-exclude',(1000,600),(0,140,140)),('small-exclude',(80,850),(0,255,255)),('fully_occluded-exclude',(1100,600),(0,255,255))]:
 actual=im(case).getpixel(pt);rows.append({'case':case,'point':pt,'expected':want,'actual':actual,'passed':max(abs(a-b) for a,b in zip(actual,want))<=2})
for p in r.glob('*-*/capture/frame-0.png'):rows.append({'case':p.parents[1].name,'check':'full monitor dimensions','passed':Image.open(p).size==(1600,1000)})
for case in ['five-exclude','no_excluded-exclude','minimized-exclude']:
 a=im(case);b=Image.open(r/case/'desktop.png').convert('RGB');rows.append({'case':case,'check':'wallpaper preserved','passed':a.getpixel((790,600))==b.getpixel((790,600))});rows.append({'case':case,'check':'system Apple menu retained, mean RGB difference <= 2 (native composition rounding)' ,'passed':max(ImageStat.Stat(ImageChops.difference(a.crop((0,0,40,24)),b.crop((0,0,40,24)))).mean)<=2})
rows.append({'case':'five-empty','check':'strict empty include','passed':all(v==(0,0) for v in im('five-empty').getextrema())})
(r/'pixel-assertions.json').write_text(json.dumps(rows,indent=2));print(json.dumps({'passed':sum(x['passed'] for x in rows),'total':len(rows),'failed':[x for x in rows if not x['passed']]},indent=2));assert all(x['passed'] for x in rows)
