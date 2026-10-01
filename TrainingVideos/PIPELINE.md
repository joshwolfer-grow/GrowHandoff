# Grow Training Video Pipeline

Drop zone: put each recording in `footage/` and its deck (pptx or pdf) in `decks/`,
matching names (e.g. `footage/06-how-pay-works.mp4` + `decks/06-how-pay-works.pptx`).
Audio: run the raw audio through Adobe Podcast Enhance Speech (~70% mix) and drop the
enhanced wav/mp3 alongside as `<basename>-enhanced.wav`. Audio only — never let Adobe
re-export the video. It gets remuxed onto the original video BEFORE step 1 so every
timestamp downstream is built on final sound.

## Flow per video
0. **Remux** — if `<basename>-enhanced.*` exists, swap it onto the video (sync holds, Enhance never trims)
1. **Transcribe** — whisper (base.en) → timestamped SRT in `work/<video>/`
2. **Cut list** — read transcript, mark filler/restarts/dead air, propose cuts → Josh approves
3. **Cue sheet** — every span tagged with a source:
   - ON CAM (default; fewer, longer holds — not choppy)
   - SLIDE (deck page, rendered to PNG)
   - CARD (HTML→PNG via headless Chrome: numbers, pay math, key phrases)
   - STOCK (Pexels photo or video clip)
   - GEN (Gemini illustration, diagrams only — no fake people)
   - CANVA (existing approved graphics via Canva MCP export)
4. **Asset pass** — parallel subagents, one per source type (see Roles)
5. **Assembly** — single editor agent builds the ffmpeg graph: cuts, overlays,
   captions, loudnorm. Output → `output/`
6. **QA** — frame extraction at every transition + caption spot-check, then deliver.

## Subagent roles
- **captions**: clean whisper text (casing, numbers as digits, no filler words),
  max 2 lines / ~42 chars per line, bottom-safe area, never overlapping lower thirds.
- **images**: Pexels search + contact sheet, visually verify relevance/quality,
  crop/scale to 1920x1080 FIT (no zoom/pan drift, no weird crops).
- **video-broll**: Pexels video clips (licensed for reuse); Gemini generation for
  diagrams/illustrations where no real footage fits.
- **canva**: pull matching slides/graphics from BRIA MATERIALS / Sales Playbook
  folders via Canva export, render deck pages to PNG.
- **editor** (sole compiler): owns the timeline, consumes all asset manifests,
  builds and runs ffmpeg, no asset decisions of its own.
- **qa**: extracts stills at transitions, checks caption legibility, sync, levels.

## Style rules (Josh)
- No dashes in on-screen copy.
- Photos/videos: clear, fit to screen, NO ken-burns zooms or drifts.
- Slides go full-frame; voice continues underneath.
- Verbatim-on-slide items (pitch, pay numbers, never-say lines) must match deck exactly.
- Captions clean and small; don't dominate the frame.
- Card style: dark bg #0d0d0d, green accent #00e07a, Helvetica/Archivo-safe fonts
  (canvas/drawtext-safe: no -apple-system).

## Recording guidance
- 1080p or better, landscape, camera at eye level.
- Quiet room; audio matters more than picture (loudnorm fixes levels, not echo).
- Leave a beat of silence between sections; restart a flubbed sentence from its top
  (clean cut points).
- Don't point at a screen; say "as you can see here" and keep eyes on lens —
  the visual gets added in post.

## Tools
- ffmpeg/ffprobe: ~/.local/bin (PATH: export PATH="$HOME/.local/bin:$PATH")
- whisper: /Library/Frameworks/Python.framework/Versions/3.10/bin/whisper
- scripts/pexels-fetch.sh "query" [photos|videos] [n]
- scripts/gemini-image.sh "prompt" out.png
- scripts/render-card.sh card.html card.png
- Keys in .env (chmod 600, not committed anywhere)
