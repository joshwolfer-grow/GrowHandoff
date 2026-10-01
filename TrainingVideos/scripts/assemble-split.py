#!/usr/bin/env python3
"""
assemble-split.py work/<dir> <name>   -> output/<video>.mp4

For side-by-side recordings: one 3024x982 source where the left half is the
screen (deck or browser) and the right half is the webcam. The screen is the
base layer and runs the whole way; the cue sheet lists only the spans that cut
to camera. Hard cuts, no dissolves: this is an A/B camera switch, not an overlay.

Reads work/<dir>/<name>.cuesheet.json:
{
 "video": "06-pay",
 "source": "/abs/path/to/recording.mov",
 "screen": [1512, 850, 0, 56],      # crop w,h,x,y for the screen pane
 "cam":    [1512, 850, 1512, 20],   # crop w,h,x,y for the webcam pane
 "captions": "06-pay.captions.srt",  # optional, source times, remapped here
 "drops": [{"start": 12.0, "end": 14.2}],           # dead air / flubs, cut first
 "cam_cues": [{"start": 0.0, "end": 14.0, "why": "intro"}],  # source times
 "blurs": [{"start": 213.0, "end": 250.0, "rect": [340, 290, 1090, 692],
            "why": "other reps' profit share"}]    # rect in SOURCE pane pixels
}
Times in drops, cam_cues, blurs and the caption file are SOURCE times. Drops are
applied first and everything else is remapped onto the trimmed timeline.
"""
import json, os, subprocess, sys, shlex, re

os.environ["PATH"] = os.path.expanduser("~/.local/bin") + ":" + os.environ["PATH"]
ROOT = os.path.expanduser("~/Grow/TrainingVideos")

d = sys.argv[1].rstrip("/")
if not d.startswith("/"):
    d = os.path.join(ROOT, d)
name = sys.argv[2]
cs = json.load(open(f"{d}/{name}.cuesheet.json"))
src = cs["source"]
MIN_CAM = 2.0          # never flash to camera for less than this
MIN_SCREEN_GAP = 1.5   # two cam cues closer than this become one


def probe(p):
    return float(subprocess.check_output(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration",
         "-of", "csv=p=0", p]).decode().strip())


def remap(t, drops):
    """Source time -> trimmed time. Accumulate the shift and always compare the
    ORIGINAL t against each drop: comparing a partly shifted t against the next
    drop's source boundaries silently under-shifts everything after it."""
    shift = 0.0
    for dr in drops:
        a, b = dr["start"], dr["end"]
        if t >= b:
            shift += (b - a)
        elif t > a:
            return a - shift
    return t - shift


# ---------- 1. drops: build the trimmed base from the source ----------
drops = sorted(cs.get("drops", []), key=lambda x: x["start"])
clean = f"{d}/{name}.clean.mp4"
total = probe(src)
if drops:
    keeps, cur = [], 0.0
    for dr in drops:
        keeps.append((cur, dr["start"]))
        cur = dr["end"]
    keeps.append((cur, total))
    keeps = [(a, b) for a, b in keeps if b - a > 0.05]
    parts = "".join(
        f"[0:v]trim=start={a}:end={b},setpts=PTS-STARTPTS[v{i}];"
        f"[0:a]atrim=start={a}:end={b},asetpts=PTS-STARTPTS[a{i}];"
        for i, (a, b) in enumerate(keeps))
    n = len(keeps)
    fg = parts + "".join(f"[v{i}][a{i}]" for i in range(n)) + f"concat=n={n}:v=1:a=1[v][a]"
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-stats", "-i", src,
                    "-filter_complex", fg, "-map", "[v]", "-map", "[a]",
                    "-c:v", "libx264", "-preset", "veryfast", "-crf", "16",
                    "-pix_fmt", "yuv420p", "-r", "30",
                    "-c:a", "aac", "-b:a", "192k", "-ar", "48000", clean], check=True)
    print(f"applied {len(drops)} drops, {sum(x['end']-x['start'] for x in drops):.1f}s removed")
else:
    clean = src

# ---------- 2. cam cues onto the trimmed timeline ----------
cues = []
for c in cs.get("cam_cues", []):
    a, b = remap(float(c["start"]), drops), remap(float(c["end"]), drops)
    if b - a >= 0.4:
        cues.append({"start": round(a, 2), "end": round(b, 2), "why": c.get("why", "")})
cues.sort(key=lambda c: c["start"])

merged = []
for c in cues:
    if merged and c["start"] - merged[-1]["end"] < MIN_SCREEN_GAP:
        merged[-1]["end"] = max(merged[-1]["end"], c["end"])
        merged[-1]["why"] += " + " + c["why"]
    else:
        merged.append(c)
for c in merged:
    if c["end"] - c["start"] < MIN_CAM:
        c["end"] = c["start"] + MIN_CAM
cues = merged

# ---------- 3. privacy blurs, screen base, camera cut-ins ----------
sw, sh, sx, sy = cs["screen"]
cw, ch, cx, cy = cs["cam"]
blurs = []
for b in cs.get("blurs", []):
    a, e = remap(float(b["start"]), drops), remap(float(b["end"]), drops)
    if e - a > 0.1:
        blurs.append({"start": round(a, 2), "end": round(e, 2), "rect": b["rect"]})

fc = [f"[0:v]split=2[s0][c0]"]
src = "[s0]"
for i, b in enumerate(blurs):
    bx, by, bw, bh = b["rect"]
    fc.append(f"{src}split=2[bk{i}][bs{i}]")
    fc.append(f"[bs{i}]crop={bw}:{bh}:{bx}:{by},avgblur=sizeX=24:sizeY=24[bl{i}]")
    fc.append(f"[bk{i}][bl{i}]overlay={bx}:{by}:"
              f"enable='between(t,{b['start']},{b['end']})'[sb{i}]")
    src = f"[sb{i}]"
# The screen sits at 1600x900 top-aligned, same as the slides in the other
# videos, so the burned-in captions never land on top of what he is pointing at.
# Camera stays full frame.
bg = cs.get("screen_bg", "0x06090f")
fc += [
    f"{src}crop={sw}:{sh}:{sx}:{sy},scale=1600:900:force_original_aspect_ratio=decrease:"
    f"flags=lanczos,pad=1920:1080:(ow-iw)/2:20:color={bg},setsar=1,fps=30[base]",
    f"[c0]crop={cw}:{ch}:{cx}:{cy},scale=1920:1080:flags=lanczos,setsar=1,fps=30[cam]",
]
if cues:
    enable = "+".join(f"between(t,{c['start']},{c['end']})" for c in cues)
    fc.append(f"[base][cam]overlay=0:0:eof_action=pass:enable='{enable}'[sw]")
    cur = "[sw]"
else:
    cur = "[base]"

if cs.get("captions"):
    srt = cs["captions"] if cs["captions"].startswith("/") else f"{d}/{cs['captions']}"
    if drops:                      # captions are written against source time
        def ts(x):
            h, m, rest = x.split(":")
            s_, ms = rest.split(",")
            return int(h)*3600 + int(m)*60 + int(s_) + int(ms)/1000

        def fmt(t):
            t = max(t, 0)
            return (f"{int(t//3600):02d}:{int(t%3600//60):02d}:"
                    f"{int(t%60):02d},{int(round((t-int(t))*1000)):03d}")
        out, k = [], 1
        for blk in re.split(r"\n\s*\n", open(srt).read().strip()):
            lines = blk.split("\n")
            if len(lines) < 3:
                continue
            a, b = [ts(x.strip()) for x in lines[1].split("-->")]
            a2, b2 = remap(a, drops), remap(b, drops)
            if b2 - a2 < 0.3:
                continue
            out.append(f"{k}\n{fmt(a2)} --> {fmt(b2)}\n" + "\n".join(lines[2:]))
            k += 1
        srt = f"{d}/{name}.captions.remapped.srt"
        open(srt, "w").write("\n\n".join(out) + "\n")
    style = ("FontName=Arial,FontSize=14,Bold=1,PrimaryColour=&H00FFFFFF,"
             "OutlineColour=&H00000000,BackColour=&H80000000,BorderStyle=1,"
             "Outline=2,Shadow=0,MarginV=36,Alignment=2")
    fc.append(f"{cur}subtitles='{srt}':force_style='{style}'[vc]")
    cur = "[vc]"

fc.append(f"{cur}format=yuv420p[vout]")
fc.append("[0:a]loudnorm=I=-16:TP=-1.5:LRA=11[aout]")

out = os.path.join(ROOT, "output", cs["video"] + ".mp4")
os.makedirs(os.path.dirname(out), exist_ok=True)
cmd = ["ffmpeg", "-y", "-v", "error", "-stats", "-i", clean,
       "-filter_complex", ";".join(fc), "-map", "[vout]", "-map", "[aout]",
       "-c:v", "libx264", "-preset", "medium", "-crf", "19", "-r", "30",
       "-c:a", "aac", "-b:a", "192k", "-ar", "48000", out]
open(f"{d}/{name}.assemble-cmd.txt", "w").write(" ".join(shlex.quote(x) for x in cmd))
subprocess.run(cmd, check=True)

cam_time = sum(c["end"] - c["start"] for c in cues)
final = probe(out)
print(f"wrote {out}")
print(f"{final/60:.1f} min, {len(cues)} cuts to camera, "
      f"{cam_time:.0f}s on camera ({100*cam_time/final:.0f}%), rest on screen")
