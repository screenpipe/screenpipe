# screenpipe — AI that knows everything you've seen, said, or heard
# https://screenpipe.com
from pathlib import Path
from datetime import datetime
import hashlib,json,re,subprocess,sys
from PIL import Image
config=json.loads(Path(sys.argv[1]).read_text())
root=Path('outputs/redaction-validation/windows');work=Path('work/redaction-video/windows-final');work.mkdir(parents=True,exist_ok=True);(root/'videos').mkdir(exist_ok=True)
source=Path(config['source'])
def length(path):
 info=subprocess.run(['ffmpeg','-hide_banner','-i',str(path)],capture_output=True,text=True).stderr
 h,m,s=map(float,re.search(r'Duration: (\d+):(\d+):([\d.]+)',info).groups());return h*3600+m*60+s
source_lengths={str(source):length(source)}
blank=work/'no-snapshot.jpg';Image.new('RGB',(1024,768),(17,24,34)).save(blank)
base="[0:v]scale=920:600:force_original_aspect_ratio=decrease,pad=920:600:(ow-iw)/2:(oh-ih)/2:color=0x182130,setsar=1[l];[1:v]scale=920:600:force_original_aspect_ratio=decrease,pad=920:600:(ow-iw)/2:(oh-ih)/2:color=0x182130,setsar=1[r];[l][r]hstack=inputs=2,pad=1920:820:40:100:color=0x101722,drawtext=fontfile=/System/Library/Fonts/Supplemental/Arial.ttf:text='Native Windows desktop':x=40:y=40:fontsize=30:fontcolor=white,drawtext=fontfile=/System/Library/Fonts/Supplemental/Arial.ttf:text='Stored screenshot sample':x=960:y=40:fontsize=30:fontcolor=white"
clips=[];manifest=[]
for index,segment in enumerate(config['segments']):
 segment_source=Path(segment.get('source',str(source)));source_lengths.setdefault(str(segment_source),length(segment_source))
 offset=segment['source_offset_seconds'];duration=segment['duration_seconds'];assert offset>=0 and offset+duration<=source_lengths[str(segment_source)]
 sample=Path(segment['screenshot']) if segment.get('screenshot') else blank
 caption=work/f'caption-{index}.txt';caption.write_text(segment['caption'])
 filt=base+f',drawtext=fontfile=/System/Library/Fonts/Supplemental/Arial.ttf:textfile={caption}:expansion=none:x=32:y=743:fontsize=27:fontcolor=white'
 if not segment.get('screenshot'):filt+=",drawtext=fontfile=/System/Library/Fonts/Supplemental/Arial.ttf:text='No screenshot stored':x=1220:y=390:fontsize=32:fontcolor=white"
 clip=work/f'clip-{index}.mp4'
 subprocess.run(['ffmpeg','-loglevel','error','-y','-ss',str(offset),'-i',str(segment_source),'-loop','1','-i',str(sample),'-filter_complex',filt+'[v]','-map','[v]','-t',str(duration),'-r','24','-c:v','libx264','-preset','fast','-crf','23','-pix_fmt','yuv420p',str(clip)],check=True)
 clips.append(clip);manifest.append({**segment,'sample_sha256':hashlib.sha256(sample.read_bytes()).hexdigest() if segment.get('screenshot') else None})
listing=work/'clips.txt';listing.write_text(''.join("file '"+str(p.resolve())+"'\n" for p in clips))
script=work/'narration.txt';script.write_text(config['narration']);audio=work/'narration.aiff'
subprocess.run(['say','-v','Samantha','-r','175','-f',str(script),'-o',str(audio)],check=True)
duration=sum(s['duration_seconds'] for s in config['segments']);assert length(audio)<=duration
out=root/'videos/recorder-session-review.mp4'
subprocess.run(['ffmpeg','-loglevel','error','-y','-f','concat','-safe','0','-i',str(listing),'-i',str(audio),'-map','0:v','-map','1:a','-t',str(duration),'-c:v','copy','-c:a','aac','-af','apad','-movflags','+faststart',str(out)],check=True)
receipt={'source':str(source),'source_sha256':hashlib.sha256(source.read_bytes()).hexdigest(),'source_durations_seconds':source_lengths,'source_sha256_by_path':{p:hashlib.sha256(Path(p).read_bytes()).hexdigest() for p in source_lengths},'output':str(out),'output_sha256':hashlib.sha256(out.read_bytes()).hexdigest(),'duration_seconds':duration,'profile':'release','segments':manifest,'narration':script.read_text(),'edits':'Excerpts from native console recording at normal playback speed; actual stored JPEG samples alongside, explicit empty panel for a verified no-snapshot case. Setup/build time omitted. Narration and concise captions added.'}
(root/'recorder-video-manifest.json').write_text(json.dumps(receipt,indent=2));print(out)
