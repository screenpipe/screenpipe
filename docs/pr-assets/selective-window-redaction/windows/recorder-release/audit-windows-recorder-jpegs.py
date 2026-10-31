# screenpipe — AI that knows everything you've seen, said, or heard
# https://screenpipe.com
from pathlib import Path
import hashlib,json,sys
import numpy as np
from PIL import Image
out=Path(sys.argv[1]);cases=[]
for value in sys.argv[2:]:
 root=Path(value);frames=[]
 for p in sorted(root.rglob('*.jpg')):
  a=np.asarray(Image.open(p).convert('RGB'))
  marker=(a[:,:,0]>200)&(a[:,:,1]<60)&(a[:,:,2]>200)
  allowed=(a[:,:,0]<30)&(a[:,:,1]>220)&(a[:,:,2]>220)
  frames.append({'file':str(p.relative_to(root)),'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'width':int(a.shape[1]),'height':int(a.shape[0]),'excluded_marker_pixels':int(marker.sum()),'allowed_pixels':int(allowed.sum())})
 passed=bool(frames) and all(f['excluded_marker_pixels']==0 and f['allowed_pixels']>1000 and (f['width'],f['height'])==(1024,768) for f in frames)
 cases.append({'source_directory':str(root),'images':len(frames),'passed':passed,'frames':frames})
receipt={'method':'Every pixel of every actual stored JPEG reopened with Pillow and scanned by NumPy. Magenta excluded marker: R>200,G<60,B>200; allowed cyan: R<30,G>220,B>220. Useful content threshold>1000; exact native dimensions1024x768. This marker audit is separate from numeric alpha A/B and indexed-metadata checks.','cases':cases,'passed':all(c['passed'] for c in cases)}
out.parent.mkdir(parents=True,exist_ok=True);out.write_text(json.dumps(receipt,indent=2));print(json.dumps({'passed':receipt['passed'],'cases':[{k:c[k] for k in ['source_directory','images','passed']} for c in cases]},indent=2));assert receipt['passed']
