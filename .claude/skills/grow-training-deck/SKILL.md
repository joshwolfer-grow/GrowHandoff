---
name: grow-training-deck
description: Build Grow LMS training slide decks (.pptx) matching the exact visual style of existing Grow training decks like Preparing For Your Blitz and Pitch Deep Dive. Use this skill whenever the user asks to create a training deck, slide deck, training module, or LMS slides for Grow, Grow Marketing, or Grow reps — even if they only say "training slides" or "deck for reps" without naming Grow explicitly. Also use whenever the user references the Grow LMS, blitz training, pitch training, ISP training, or anything that should match the dark-background, Archivo-Black-titled, Garet-bodied Grow template format. Trigger on phrases like "make a training deck", "build slides for reps", "new LMS slides", "training presentation", "slide deck for Grow", or any request mentioning Grow training content delivered as slides.
---

# Grow Training Deck Skill

Build .pptx training decks that visually match the existing Grow LMS deck format (e.g. "Preparing For Your Blitz and Blitz Life", "Pitch Deep Dive: Value", "Post Blitz Training").

## Workflow

1. **Confirm logo source.** The Grow logo is NOT stored in this skill. Ask the user to upload `GROW_LOGO.png` if it's not already in `/mnt/user-data/uploads/`. If they have a black-background JPEG of the logo (white logo on black), that's expected — the prep step handles it.

2. **Confirm the outline.** Before generating, summarize the slide list back to the user for approval. The standard Grow deck structure is:
   - Cover (section title style — just big centered title, logo bottom-left)
   - Overview (bullet list of what the deck covers)
   - Content slides (one per topic)
   - Summary (recap bullets)
   - "Grow Marketing" closing slide (same style as cover)

3. **Process the logo.** Run the prep script to crop the logo and create a transparent white version for use on the dark slides:
   ```bash
   cd /home/claude
   cp /mnt/user-data/uploads/GROW_LOGO.png .
   python3 scripts/prep_logo.py
   ```
   This writes `grow_logo_white_transparent.png` to `/home/claude/`.

4. **Generate the deck.** Use the bundled `build_deck_template.js` as a starting point. Edit ONLY the slide content section at the bottom — never change the style constants, helper functions, layout dimensions, or font names. Run with:
   ```bash
   cd /home/claude && node build_deck.js
   ```

5. **Convert to images for QA.** Always render and visually check before shipping:
   ```bash
   python3 /mnt/skills/public/pptx/scripts/office/soffice.py --headless --convert-to pdf <name>.pptx
   rm -f slide-*.jpg
   pdftoppm -jpeg -r 100 <name>.pdf slide
   ```
   View slides and confirm no text overflows the slide bounds, no body text crashes into the title, logo is bottom-left on every slide.

6. **Ship.** Copy the .pptx to `/mnt/user-data/outputs/` and call `present_files`.

## Critical Style Rules (NEVER deviate)

These are measured from real Grow template PDFs. Match exactly.

### Canvas
- **Layout:** `LAYOUT_WIDE` (13.333" × 7.5"). NEVER use LAYOUT_16x9 (10×5.625) — that's 75% the right size and looks cramped.
- **Background:** `06090F` (near-black, very faint navy tint). Not pure black, not navy.

### Fonts
- **Title font:** `Archivo Black` — all caps, with `charSpacing: 8` on content slide titles, `charSpacing: 1` on big section/cover titles.
- **Body font:** `Garet` — sentence case, no formatting tricks.
- **DO NOT** use a fallback font in the code. The user has Archivo Black and Garet installed; substitute fonts will render correctly when they open in PowerPoint/Keynote.

### Cover and section title slides (big centered title)
- Title: 96pt, Archivo Black, all caps, white, centered horizontally and vertically.
- Title box: `x: 0.5, y: 2.0, w: 12.333, h: 3.5`
- Logo bottom-left only. No subtitle. No accent lines. No decorations.

### Content slides
- Title: 44pt, Archivo Black, all caps, white, left-aligned, `charSpacing: 8`.
- Title box: `x: 0.78, y: 0.6, w: 11.8, h: 1.3`
- Body: 26pt, Garet, white, left-aligned.
- Body box: `x: 0.78, y: 2.1, w: 11.8, h: 4.2`
- `paraSpaceAfter: 10` between bullets.
- Top-level bullets: filled circles (`{ bullet: { code: "25CF" } }`).
- Sub-bullets: hollow circles (`{ bullet: { code: "25CB" } }`), `indentLevel: 1`.
- Never more than one level of nesting in a single deck unless the user asks.

### Logo (every slide)
- Position: `x: 0.81, y: 6.57`
- Size: `w: 1.13, h: 0.19`
- Use the white-transparent version (`grow_logo_white_transparent.png`).
- ALWAYS bottom-left. NEVER top, NEVER center, NEVER right.

### What NOT to include (template anti-patterns)
- NO numbered markers (01, 02, 03) next to bullets
- NO italic intro/lead-in lines below the title
- NO accent lines or dividers under titles
- NO "GROW TRAINING" eyebrow text in the corner
- NO header/footer bars or colored stripes
- NO subtitle on cover slides
- NO em-dashes inside bullet text — use plain prose
- NO icons or colored circles
- Body bullet text should be one short clause per line, not multi-sentence paragraphs

### Voice
Match the existing decks: declarative, instructional, plainspoken. Short clauses. Direct rep-to-rep language. Don't pad with adverbs or polish. If a sentence reads like marketing copy, rewrite it.

## Files in this skill

- `scripts/prep_logo.py` — Crops and recolors the uploaded GROW_LOGO.png into a white-on-transparent version sized for slide use.
- `scripts/build_deck_template.js` — The pptxgenjs build script. Copy to `/home/claude/build_deck.js`, edit only the slide content section at the bottom, then run.

## Common requests and what to do

- **"Build a deck on X for reps"** → Standard structure: Cover → Overview → 4-6 content slides → Summary → Grow Marketing close.
- **"Match the other training decks"** → Already the default. Don't add anything fancy.
- **"Make it the same as Preparing For Your Blitz"** → Same as default. The template IS that style.
- **User uploads a different logo color** → Still run prep_logo.py; it converts whatever's provided into white-on-transparent. Confirm with user if the result looks wrong.
