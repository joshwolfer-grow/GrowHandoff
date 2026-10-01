#!/usr/bin/env python3
"""
assemble.py work/<raw>   -> output/<video>.mp4
Reads work/<raw>/cuesheet.json:
{
 "video": "02-fiber", "title": "WHAT IS FIBER",
 "title_card": "assets/canva/02-fiber/slide-01.png",   # optional, 2.5s intro
 "end_card":   "assets/canva/02-fiber/slide-06.png",   # optional, 3s outro
 "captions": "captions.srt",                            # optional, times relative to clean.mp4
 "cues": [
   {"start": 12.0, "end": 18.5, "type": "slide"|"image", "file": "path.png"},
   {"start": 40.0, "end": 46.0, "type": "video", "file": "path.mp4", "offset": 0},
   {"start": 5.0,  "end": 30.0, "type": "lowerthird", "text": "WHAT FIBER IS"}
 ]
}
All cue times are relative to clean.mp4. Full-frame cues (slide/image/video) must not overlap each other.
"""
import json, os, subprocess, sys, shlex
os.environ["PATH"] = os.path.expanduser("~/.local/bin") + ":" + os.environ["PATH"]
ROOT = os.path.expanduser("~/Grow/TrainingVideos")
d = sys.argv[1].rstrip("/")
if not d.startswith("/"): d = os.path.join(ROOT, d)
cs = json.load(open(f"{d}/cuesheet.json"))
def P(p): return p if p.startswith("/") else os.path.join(ROOT, p)
FONT_BOLD = "/System/Library/Fonts/Supplemental/Arial Bold.ttf"
FONT_BLACK = "/System/Library/Fonts/Supplemental/Arial Black.ttf"
FADE = 0.3
clean = f"{d}/clean-stab.mp4" if os.path.exists(f"{d}/clean-stab.mp4") else f"{d}/clean.mp4"

# optional late drops on the clean timeline: {"drops":[{"start":s,"end":e}]} -> clean2.mp4, cues/captions remapped
def _remap(t, drops):
    # Accumulate the shift and always compare the ORIGINAL t against each drop.
    # Comparing a partly shifted t against the next drop's source boundaries
    # silently under-shifts everything that follows it.
    shift = 0.0
    for dr in drops:
        a,b=dr["start"],dr["end"]
        if t>=b: shift += (b-a)
        elif t>a: return a - shift
    return t - shift
if cs.get("drops"):
    drops=sorted(cs["drops"],key=lambda x:x["start"])
    total=float(subprocess.check_output(["ffprobe","-v","error","-show_entries","format=duration","-of","csv=p=0",clean]).decode())
    keeps=[]; cur=0.0
    for dr in drops: keeps.append((cur,dr["start"])); cur=dr["end"]
    keeps.append((cur,total))
    parts=[]; 
    for i,(a,b) in enumerate(keeps):
        parts.append(f"[0:v]trim=start={a}:end={b},setpts=PTS-STARTPTS[v{i}];[0:a]atrim=start={a}:end={b},asetpts=PTS-STARTPTS[a{i}];")
    n=len(keeps); fg2="".join(parts)+"".join(f"[v{i}][a{i}]" for i in range(n))+f"concat=n={n}:v=1:a=1[v][a]"
    clean2=f"{d}/clean2.mp4"
    subprocess.run(["ffmpeg","-y","-v","error","-i",clean,"-filter_complex",fg2,"-map","[v]","-map","[a]","-c:v","libx264","-preset","fast","-crf","18","-pix_fmt","yuv420p","-r","30","-c:a","aac","-b:a","192k","-ar","48000",clean2],check=True)
    clean=clean2
    for c in cs["cues"]:
        c["start"]=round(_remap(float(c["start"]),drops),2); c["end"]=round(_remap(float(c["end"]),drops),2)
    cs["cues"]=[c for c in cs["cues"] if c["end"]-c["start"]>0.4]
    if cs.get("captions"):
        import re
        srt=open(f"{d}/{cs['captions']}").read()
        def ts(x): 
            h,m,rest=x.split(":"); sec,ms=rest.split(","); return int(h)*3600+int(m)*60+int(sec)+int(ms)/1000
        def fmt(t): 
            t=max(t,0); h=int(t//3600); m=int(t%3600//60); sec=t%60; return f"{h:02d}:{m:02d}:{int(sec):02d},{int(round((sec-int(sec))*1000)):03d}"
        out=[]; k=1
        for blk in re.split(r"\n\s*\n",srt.strip()):
            lines=blk.split("\n")
            if len(lines)<3: continue
            a,b=[ts(x.strip()) for x in lines[1].split("-->")]
            a2,b2=_remap(a,drops),_remap(b,drops)
            if b2-a2<0.3: continue
            out.append(f"{k}\n{fmt(a2)} --> {fmt(b2)}\n"+"\n".join(lines[2:])); k+=1
        open(f"{d}/captions2.srt","w").write("\n\n".join(out)+"\n"); cs["captions"]="captions2.srt"
    print("drops applied:",drops)
dur = float(subprocess.check_output(["ffprobe","-v","error","-show_entries","format=duration","-of","csv=p=0",clean]).decode().strip())

inputs = ["-i", clean]
fc = []
full = [c for c in cs["cues"] if c["type"] in ("slide","image","video")]
full.sort(key=lambda c: c["start"])
for i in range(1,len(full)):
    assert full[i]["start"] >= full[i-1]["end"], f"overlapping full-frame cues at {full[i]['start']}"
# never flash back to Josh for under 2s between cutaways: extend the earlier cue to meet the next one
for i in range(1,len(full)):
    gap = float(full[i]["start"]) - float(full[i-1]["end"])
    if 0 < gap < 2.0:
        full[i-1]["end"] = full[i]["start"]
# a cue that butts up against a neighbour cuts hard (no fade) on that side, so builds don't flicker
for i, c in enumerate(full):
    c["_fi"] = not (i > 0 and float(c["start"]) - float(full[i-1]["end"]) < 0.05)
    c["_fo"] = not (i < len(full)-1 and float(full[i+1]["start"]) - float(c["end"]) < 0.05)
lts = [c for c in cs["cues"] if c["type"]=="lowerthird" and not (c["text"].strip().upper()==cs.get("title","").strip().upper() and float(c["start"])<2.0)]

# base: video 0
cur = "[0:v]"
n = 1
for c in full:
    a, b = float(c["start"]), float(c["end"])
    L = b - a + (0.05 if not c.get("_fo", True) else 0)
    if L <= 0.4: continue
    f = P(c["file"])
    assert os.path.exists(f), f"missing {f}"
    if c["type"] == "video":
        fit = "scale=1920:1080:force_original_aspect_ratio=decrease:flags=lanczos,pad=1920:1080:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1"
    elif "/assets/stock/" in f or "/assets/generated/" in f and c.get("photo"):
        # stock photos: fit (no crop) over a blurred, darkened fill of the same image instead of hard bars
        fit = ("split[bg0][fg0];[bg0]scale=1920:1080:force_original_aspect_ratio=increase,crop=1920:1080,gblur=sigma=45,eq=brightness=-0.2[bg1];"
               "[fg0]scale=1920:1080:force_original_aspect_ratio=decrease:flags=lanczos[fg1];[bg1][fg1]overlay=(W-w)/2:(H-h)/2,setsar=1")
    else:
        # slides/cards shrink to 88% and sit at the top so captions never collide with slide text (bg matches, seam invisible)
        fit = "scale=1600:900:force_original_aspect_ratio=decrease:flags=lanczos,pad=1920:1080:(ow-iw)/2:20:color=0x06090f,setsar=1"
    if c["type"] == "video":
        off = float(c.get("offset",0))
        inputs += ["-ss", str(off), "-t", str(L), "-i", f]
        src = f"[{n}:v]{fit},fps=30,setpts=PTS-STARTPTS+{a}/TB,format=rgba"
    else:
        inputs += ["-loop","1","-t", str(L), "-i", f]
        src = f"[{n}:v]{fit},fps=30,setpts=PTS-STARTPTS+{a}/TB,format=rgba"
    fo = max(a, b - FADE)
    fades = (f",fade=t=in:st={a}:d={FADE}:alpha=1" if c["_fi"] else "") + (f",fade=t=out:st={fo}:d={FADE}:alpha=1" if c["_fo"] else "")
    fc.append(f"{src}{fades}[ov{n}]")
    fc.append(f"{cur}[ov{n}]overlay=0:0:eof_action=pass:enable='between(t,{a},{b})'[v{n}]")
    cur = f"[v{n}]"; n += 1

# lower thirds (only shown when Josh is on cam; caller responsible for not overlapping full cues)
for i, c in enumerate(lts):
    a, b = float(c["start"]), float(c["end"])
    txt = c["text"].replace("\\","\\\\").replace("'", "’").replace(":", "\\:").replace("%","\\%")
    fc.append(f"{cur}drawtext=fontfile='{FONT_BLACK}':text='{txt}':fontsize=44:fontcolor=white:"
              f"box=1:boxcolor=black@0.78:boxborderw=22:x=80:y=h-330:"
              f"enable='between(t,{a},{b})'[lt{i}]")
    cur = f"[lt{i}]"

# captions
if cs.get("captions"):
    srt = f"{d}/{cs['captions']}" if not cs["captions"].startswith("/") else cs["captions"]
    style = "FontName=Arial,FontSize=15,Bold=1,PrimaryColour=&H00FFFFFF,OutlineColour=&H00000000,BackColour=&H80000000,BorderStyle=1,Outline=2,Shadow=0,MarginV=36,Alignment=2"
    fc.append(f"{cur}subtitles='{srt}':force_style='{style}'[vc]")
    cur = "[vc]"

fc.append(f"{cur}format=yuv420p[vout]")
fc.append("[0:a]loudnorm=I=-16:TP=-1.5:LRA=11[aout]")
main = f"{d}/main.mp4"
cmd = ["ffmpeg","-y","-v","error","-stats"] + inputs + ["-filter_complex", ";".join(fc),
       "-map","[vout]","-map","[aout]","-c:v","libx264","-preset","fast","-crf","19","-r","30",
       "-c:a","aac","-b:a","192k","-ar","48000", main]
open(f"{d}/assemble-cmd.txt","w").write(" ".join(shlex.quote(x) for x in cmd))
subprocess.run(cmd, check=True)

# intro / outro cards
parts = []
def card(img, secs, out):
    subprocess.run(["ffmpeg","-y","-v","error","-loop","1","-t",str(secs),"-i",P(img),"-f","lavfi","-t",str(secs),
        "-i","anullsrc=r=48000:cl=stereo","-vf","scale=1920:1080,fps=30,format=yuv420p,fade=t=out:st=%s:d=0.4"%(secs-0.4),
        "-c:v","libx264","-preset","medium","-crf","19","-c:a","aac","-b:a","192k","-shortest",out],check=True)
if cs.get("title_card"):
    card(cs["title_card"], 2.5, f"{d}/intro.mp4"); parts.append(f"{d}/intro.mp4")
parts.append(main)
for i, pc in enumerate(cs.get("post_cards", [])):   # e.g. APPLY IT slide held after the last word
    card(pc["file"], float(pc.get("secs", 6)), f"{d}/post{i}.mp4"); parts.append(f"{d}/post{i}.mp4")
if cs.get("end_card"):
    card(cs["end_card"], 3.0, f"{d}/outro.mp4"); parts.append(f"{d}/outro.mp4")
lst = f"{d}/concat.txt"
open(lst,"w").write("".join(f"file '{p}'\n" for p in parts))
out = os.path.join(ROOT, "output", cs["video"] + ".mp4")
os.makedirs(os.path.dirname(out), exist_ok=True)
subprocess.run(["ffmpeg","-y","-v","error","-f","concat","-safe","0","-i",lst,"-c","copy",out],check=True)
print("wrote", out)
