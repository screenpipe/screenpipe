# screenpipe — AI that knows everything you've seen, said, or heard
# https://screenpipe.com
import tkinter as tk,json,pathlib,time
root=tk.Tk(className='RedactionFixture');root.withdraw();folder=pathlib.Path.home()/'redaction';cfg=folder/'scene.json';seen=None
wins=[]
positions=[(30,45,550,400),(620,45,550,400),(1210,45,550,400),(160,510,700,440),(1010,510,700,440)]
for i,name in enumerate(['Browser','Editor','Notes','Terminal','Private']):
 w=tk.Toplevel(root);w.title(('PrivacyBlocked ' if i==4 else 'PrivacyAllowed ')+name);w.configure(bg='#ff00ff' if i==4 else '#00ffff');
 label=tk.Label(w,text=name+'\n'+('EXCLUDED' if i==4 else 'ALLOWED')+'\nSynthetic native fixture',font=('Sans',28),bg='#ff00ff' if i==4 else '#00ffff');label.pack(expand=True,fill='both');wins.append(w)
def poll():
 global seen
 try:
  raw=cfg.read_text()
  if raw!=seen:
   c=json.loads(raw);case=c.get('case','five');seen=raw
   for i,w in enumerate(wins):
    x,y,ww,hh=positions[i];w.deiconify();w.attributes('-alpha',1.0);w.geometry(f'{ww}x{hh}+{x}+{y}');w.title(('PrivacyBlocked ' if i==4 else 'PrivacyAllowed ')+str(i));w.lift()
   if case=='no_excluded':wins[4].withdraw()
   if case=='minimized':wins[4].iconify()
   if case=='offscreen':wins[4].geometry('300x200+2100+1200')
   if case in ('excluded_front','excluded_behind','transparent_front','small','blank_title'):
    wins[4].geometry('950x650+400+220');wins[0].geometry('650x420+850+460');wins[4].lift()
    if case in ('excluded_behind','transparent_front','small','blank_title'):wins[0].lift()
    if case=='transparent_front':wins[0].attributes('-alpha',0.55)
    if case=='small':
     for w in wins[1:4]:w.withdraw()
     wins[4].geometry('1920x1080+0+0');wins[0].geometry('130x85+50+50');wins[0].lift()
    if case=='blank_title':wins[0].title('')
   if case=='all_excluded':
    for w in wins:w.title('PrivacyBlocked secret')
   if case=='spanning':wins[4].geometry('700x400+1450+250')
   if case=='fully_occluded':wins[0].geometry('700x500+900+450');wins[4].geometry('450x300+1000+550');wins[0].lift()
   wins[0].focus_force()
   root.update_idletasks()
   folder.joinpath('scene-applied.json').write_text(json.dumps({'case':case,'requested':c,'time':time.time()}))
 except FileNotFoundError:pass
 root.after(80,poll)
poll();root.mainloop()
