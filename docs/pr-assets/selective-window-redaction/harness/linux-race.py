# screenpipe — AI that knows everything you've seen, said, or heard
# https://screenpipe.com
from Xlib import X,display
import pathlib,time,json,os
r=pathlib.Path.home()/'redaction';d=display.Display(':99');root=d.screen().root;end=time.monotonic()+120;cycles=0
name=d.intern_atom('_NET_WM_NAME');utf=d.intern_atom('UTF8_STRING');pid=d.intern_atom('_NET_WM_PID');card=d.intern_atom('CARDINAL')
while time.monotonic()<end:
 w=root.create_window(400,200,450,350,0,d.screen().root_depth,X.InputOutput,X.CopyFromParent,background_pixel=0xff00ff,override_redirect=1)
 w.set_wm_class('race','RedactionRace');w.change_property(name,utf,8,b'PrivacyBlocked transient');w.change_property(pid,card,32,[os.getpid()]);w.map();d.sync();time.sleep(.025)
 w.configure(x=700,y=350,width=500,height=450);d.sync();time.sleep(.025)
 w.unmap();d.sync();w.destroy();d.sync();cycles+=1
(r/'evidence/race-cycles.json').write_text(json.dumps({'cycles':cycles}))
