#!/bin/bash
# Vercel build: static payload + downloadable ops scripts (see vercel.json).
set -e
mkdir -p public/scripts
cp index.html apply.html schedule.html training.html calculator.html manifest.json sw.js icon.png 'GROW LOGO.png' grow-wordmark.png team-assignments.json team-current.json public/
cp api/_merch-email.js public/merch-email.js
find scripts -maxdepth 1 -type f \( -name '*.mjs' -o -name '*.py' -o -name '*.gs' -o -name '*.sh' \) -exec cp {} public/scripts/ \;
# install-slots walks ISP partner portals; it is an ops-Mac tool, never published
rm -f public/scripts/install-slots.mjs public/scripts/run-install-slots.sh
cp api/_name-aliases.js public/scripts/
# the sector map viewer (More > ISP Maps). Its data comes from the sector_maps
# table at runtime, so only the page itself ships, never a built map.
mkdir -p public/maps
cp maps/view.html public/maps/view.html
printf '%s' 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImNta2ZvaHdiZWpjenRjdHJwZG50Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIyNDYyODgsImV4cCI6MjA5NzgyMjI4OH0.waLa5E9a6SMvJ70keY9duAz4VxK39sDNNbmPSSbcebo' > public/scripts/anon-key.txt
