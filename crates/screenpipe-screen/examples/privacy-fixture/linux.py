# screenpipe — AI that knows everything you've seen, said, or heard
# https://screenpipe.com

import tkinter as tk
import os
import time
import math
root = tk.Tk(className='PrivacyAllowed')
root.title('PrivacyAllowed')
root.geometry('500x500+80+100')
root.configure(background='#00ffff')
other = tk.Toplevel(root, class_='PrivacyBlocked')
other.title('PrivacyBlocked')
other.geometry('350x300+420+250')
other.configure(background='#ff00ff')
root.after(1000, lambda: other.lift())
def animate():
    phase = time.monotonic()
    other.geometry(f"350x300+{420 + int(70 * math.sin(phase * 8))}+{250 + int(50 * math.cos(phase * 8))}")
    (other if int(phase * 8) % 2 == 0 else root).lift()
    root.after(30, animate)
if os.getenv('PRIVACY_ANIMATE'):
    root.after(1000, animate)
root.mainloop()
