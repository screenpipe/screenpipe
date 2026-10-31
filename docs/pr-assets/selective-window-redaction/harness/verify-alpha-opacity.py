# screenpipe — AI that knows everything you've seen, said, or heard
# https://screenpipe.com
from pathlib import Path
from PIL import Image
import json,sys
root=Path(sys.argv[1]);os_name=sys.argv[2]
crop=(1000,570,1200,700) if os_name=='macos' else (1050,550,1250,650)
checks=[]
for case in ['transparent_front','transparent_front_b']:
 image=Image.open(root/'alpha/exclude'/case/'capture/frame-0.png').convert('RGB').crop(crop)
 pixels=list(image.getdata());matching=sum(r<=3 and abs(g-140)<=2 and abs(b-140)<=2 for r,g,b in pixels)
 checks.append({'case':case,'crop':crop,'expected_rgb':[0,140,140],'expected_global_opacity':0.55,'matching_pixels':matching,'total_pixels':len(pixels),'fraction':matching/len(pixels),'passed':matching/len(pixels)>0.8})
(root/'alpha-opacity-acceptance.json').write_text(json.dumps(checks,indent=2))
assert all(row['passed'] for row in checks)
