# 4-Year Window decks, build

Rebuild after editing the slide content section at the bottom of build_deck.js:

    cd build && npm install && OUT_DIR=.. node build_deck.js
    python3 preview.py ../*.pptx      # renders slide PNGs into ../preview/ for QA

Style constants and helpers are the grow-training-deck skill template, unchanged.
No LibreOffice or PowerPoint on this Mac, so preview.py draws the slides itself
with the template geometry and outlines any box that would overflow in red.
