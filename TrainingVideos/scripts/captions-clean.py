#!/usr/bin/env python3
"""
captions-clean.py in.srt out.srt

Whisper transcripts of the Grow videos get the same handful of names and product
words wrong every time. This fixes those, drops the stalls, normalises numbers,
strips dashes (house style) and rewraps to at most two lines of ~42 characters.
Times are left alone.
"""
import re, sys

FIX = [
    (r"\bSQL\s?FI\b", "Sequifi"), (r"\bSequify\b", "Sequifi"), (r"\bSequifi\b", "Sequifi"),
    (r"\bKoi Dros-Mason\b", "Quaid Rasmussen"), (r"\bQuid Rasmussen\b", "Quaid Rasmussen"),
    (r"\bJeff'?s (?:function|assumption|sumption)\b", "Jeff Sumsion"),
    (r"\bJeff Sumption\b", "Jeff Sumsion"),
    (r"\bSha[yl]+e[ye]? In[sz]ine\b", "Shaylee Ensign"),
    (r"\bShaley Inzine\b", "Shaylee Ensign"),
    (r"\bDachshunday\b", "Daxton Day"), (r"\bDaxton Day\b", "Daxton Day"),
    (r"\bSpencer Ailes\b", "Spencer Ales"),
    (r"\bJosh Wolfer\b", "Josh Wolfer"),
    (r"\bsegue\b", "Segway"), (r"\bSegue\b", "Segway"),
    (r"\breplete\b", "repeat"),
    (r"\bcore for\b", "Core Four"), (r"\bCore for\b", "Core Four"),
    (r"\b[Oo]utput share\b", "Profit share"),
    (r"\bclaw rate\b", "clawback rate"),
    (r"\bgrow\b", "Grow"), (r"\bGRO\b", "Grow"), (r"\bGROW\b", "Grow"),
    (r"\bPronto\b", "Pronto"),
    (r"(\d+)\s?megabyte", r"\1 Mbps"), (r"(\d+)\s?gigabyte", r"\1 gig"),
    (r"\bfull trip\b", "fall trip"),
    # stalls and self-corrections that add nothing on screen
    (r"\byou know what I'?m saying\?\s*", ""),
    (r"\b[Aa]nyways,?\s*", ""),
    (r"\s*\ber+,?\s*", " "),
]
# house style: no dashes anywhere in on-screen copy
DASH = [(r"\s+[-–—]+\s+", ", "), (r"[-–—]+", " ")]


def fix(t):
    for pat, rep in FIX:
        t = re.sub(pat, rep, t)
    for pat, rep in DASH:
        t = re.sub(pat, rep, t)
    t = re.sub(r"\s+", " ", t).strip()
    t = re.sub(r"\s+([,.!?])", r"\1", t)
    t = re.sub(r",\s*,", ",", t)
    return t


def _lines(t, width):
    lines, cur = [], ""
    for w in t.split():
        if cur and len(cur) + 1 + len(w) > width:
            lines.append(cur)
            cur = w
        else:
            cur = f"{cur} {w}".strip()
    if cur:
        lines.append(cur)
    return lines


def wrap(t, width=42):
    """At most two lines. Widen until it fits rather than spilling to a third."""
    for w in range(width, 81):
        lines = _lines(t, w)
        if len(lines) <= 2:
            return "\n".join(lines)
    return "\n".join(_lines(t, (len(t) + 1) // 2 + 2)[:2])


out, k = [], 1
for blk in re.split(r"\n\s*\n", open(sys.argv[1]).read().strip()):
    L = blk.split("\n")
    if len(L) < 3:
        continue
    txt = fix(" ".join(L[2:]))
    if not txt or txt in {".", ","}:
        continue
    out.append(f"{k}\n{L[1]}\n{wrap(txt)}")
    k += 1
open(sys.argv[2], "w").write("\n\n".join(out) + "\n")
print(f"{sys.argv[2]}: {k-1} caption blocks")
