# screenpipe — AI that knows everything you've seen, said, or heard
# https://screenpipe.com
import os, fcntl, struct, json
root='/Volumes/Screenpipe/Mac Mini'
os.makedirs(root,exist_ok=True)
p=root+'/probe'
with open(p,'w+b') as f:
    f.write(b'x'*1048576)
    f.flush()
    for name,op in [('file_fsync',lambda:os.fsync(f.fileno())),('file_fullfsync',lambda:fcntl.fcntl(f,51)),('hole_punch',lambda:fcntl.fcntl(f,99,struct.pack('IIqq',0,0,0,1048576)))]:
        try: op(); print(json.dumps({'operation':name,'result':'ok'}))
        except OSError as e: print(json.dumps({'operation':name,'errno':e.errno,'error':str(e)}))
fd=os.open(root,os.O_RDONLY)
try:
    os.fsync(fd); print(json.dumps({'operation':'directory_fsync','result':'ok'}))
except OSError as e: print(json.dumps({'operation':'directory_fsync','errno':e.errno,'error':str(e)}))
os.close(fd)
os.unlink(p)
