#!/usr/bin/env python3
"""apply-cutlist.py work/<raw>  -> work/<raw>/clean.mp4 (1920x1080, letterbox cropped, keeps concatenated)"""
import json, subprocess, sys, os
os.environ["PATH"] = os.path.expanduser("~/.local/bin") + ":" + os.environ["PATH"]
d = sys.argv[1].rstrip("/")
cl = json.load(open(f"{d}/cutlist.json"))
src = os.path.expanduser("~/Grow/TrainingVideos/" + cl["source"]) if not cl["source"].startswith("/") else cl["source"]
keeps = cl["keep"]
CROP = "crop=3408:1920:6:172,scale=1920:1080:flags=lanczos"
parts = []
for i, k in enumerate(keeps):
    parts.append(f"[0:v]trim=start={k['start']}:end={k['end']},setpts=PTS-STARTPTS,{CROP}[v{i}];"
                 f"[0:a]atrim=start={k['start']}:end={k['end']},asetpts=PTS-STARTPTS[a{i}];")
n = len(keeps)
concat = "".join(f"[v{i}][a{i}]" for i in range(n)) + f"concat=n={n}:v=1:a=1[v][a]"
fg = "".join(parts) + concat
out = f"{d}/clean.mp4"
cmd = ["ffmpeg","-y","-v","error","-stats","-i",src,"-filter_complex",fg,"-map","[v]","-map","[a]",
       "-c:v","libx264","-preset","medium","-crf","18","-pix_fmt","yuv420p","-r","30",
       "-c:a","aac","-b:a","192k","-ar","48000",out]
print("keeps:", n, "total kept:", round(sum(k['end']-k['start'] for k in keeps),1), "s")
subprocess.run(cmd, check=True)
print("wrote", out)
