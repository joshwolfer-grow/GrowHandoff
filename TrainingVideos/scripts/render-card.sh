#!/bin/zsh
# usage: render-card.sh input.html output.png
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --headless --disable-gpu --hide-scrollbars \
  --screenshot="$2" --window-size=1920,1080 "file://$(realpath $1)" 2>/dev/null
