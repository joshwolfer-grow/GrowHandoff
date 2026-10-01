#!/usr/bin/env python3
"""qa-stills.py work/<raw> : pull a still ~1s into every cue (plus a few on-cam frames) from output/<video>.mp4 -> work/<raw>/qa/montage-N.jpg (max 20 per sheet)"""
import json,subprocess,os,sys
os.environ["PATH"]=os.path.expanduser("~/.local/bin")+":"+os.environ["PATH"]
ROOT=os.path.expanduser("~/Grow/TrainingVideos"); d=sys.argv[1].rstrip("/")
if not d.startswith("/"): d=os.path.join(ROOT,d)
cs=json.load(open(f"{d}/cuesheet.json")); INTRO=2.5 if cs.get("title_card") else 0
out=os.path.join(ROOT,"output",cs["video"]+".mp4"); qa=f"{d}/qa"; os.makedirs(qa,exist_ok=True)
for f in os.listdir(qa):
    if f.startswith("f") or f.startswith("montage"): os.remove(os.path.join(qa,f))
pts=[(1.0,"title")]
for c in cs["cues"]:
    if c["type"] in("slide","image","video"): pts.append((c["start"]+INTRO+1.0, f"{c['type']} {os.path.basename(c.get('file',''))}"))
    elif c["type"]=="lowerthird": pts.append((c["start"]+INTRO+2.0, "LT "+c["text"]))
dur=float(subprocess.check_output(["ffprobe","-v","error","-show_entries","format=duration","-of","csv=p=0",out]).decode())
pts.append((dur-1.5,"end"))
pts.sort()
files=[]
for i,(t,lab) in enumerate(pts):
    f=f"{qa}/f{i:02d}.jpg"; files.append(f)
    subprocess.run(["ffmpeg","-v","error","-y","-ss",f"{t:.2f}","-i",out,"-frames:v","1","-vf",
        f"scale=480:-1,drawtext=fontfile=/System/Library/Fonts/Supplemental/Arial.ttf:text='{i:02d} {t:.1f}s':fontsize=18:fontcolor=yellow:x=6:y=6",f],check=True)
open(f"{qa}/frames.txt","w").write("".join(f"{i:02d} {t:.1f}s {lab}\n" for i,(t,lab) in enumerate(pts)))
cols=4; per=20; sheets=[]
for s in range(0,len(files),per):
    chunk=files[s:s+per]; n=len(chunk); inputs=[]
    for f in chunk: inputs+=["-i",f]
    lay=[]
    for i in range(n):
        x="0" if i%cols==0 else "+".join(["w0"]*(i%cols)); y="0" if i//cols==0 else "+".join(["h0"]*(i//cols)); lay.append(f"{x}_{y}")
    m=f"{qa}/montage-{s//per}.jpg"; sheets.append(m)
    if n==1: subprocess.run(["cp",chunk[0],m])
    else: subprocess.run(["ffmpeg","-v","error","-y"]+inputs+["-filter_complex",f'{"".join(f"[{i}]" for i in range(n))}xstack=inputs={n}:layout={"|".join(lay)}:fill=black',m],check=True)
print(len(pts),"frames;",len(sheets),"sheets:"," ".join(sheets))
