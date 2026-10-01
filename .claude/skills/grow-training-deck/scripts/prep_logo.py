#!/usr/bin/env python3
"""
Prep the Grow logo for use on Grow training decks.

Input:  /home/claude/GROW_LOGO.png  (typically white logo on black background)
Output: /home/claude/grow_logo_white_transparent.png  (white logo, transparent bg)

Handles both:
- Black-background JPEGs of the white logo (common Canva export)
- PNGs with the logo already isolated
"""
from PIL import Image
import numpy as np
import os
import sys

INPUT = "/home/claude/GROW_LOGO.png"
OUTPUT = "/home/claude/grow_logo_white_transparent.png"

if not os.path.exists(INPUT):
    print(f"ERROR: {INPUT} not found. User needs to upload GROW_LOGO.png first.", file=sys.stderr)
    sys.exit(1)

img = Image.open(INPUT).convert("RGB")
arr = np.array(img)

# Find bounding box of non-near-black pixels (the logo content)
mask = arr.sum(axis=2) > 60
ys, xs = np.where(mask)
if len(ys) == 0:
    print("ERROR: No logo content detected. Image may be all black or all white.", file=sys.stderr)
    sys.exit(1)

top, bot = ys.min(), ys.max()
left, right = xs.min(), xs.max()

# Crop with small padding
pad = 20
H, W = arr.shape[:2]
cropped = img.crop((max(0, left - pad), max(0, top - pad),
                    min(W, right + pad), min(H, bot + pad)))

# Convert to white-on-transparent
rgba = cropped.convert("RGBA")
data = np.array(rgba)
brightness = data[:, :, :3].mean(axis=2)
alpha = (brightness * 1.5).clip(0, 255).astype(np.uint8)
data[:, :, 0] = 255
data[:, :, 1] = 255
data[:, :, 2] = 255
data[:, :, 3] = alpha

Image.fromarray(data).save(OUTPUT)
print(f"Logo prepped: {cropped.size[0]}x{cropped.size[1]} -> {OUTPUT}")
