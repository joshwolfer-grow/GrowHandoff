#!/bin/bash
# Wrapper the launch agent calls when a file lands in imports/. Resolves node
# (nvm-friendly), then imports every CSV in imports/ and moves them to done/.
NODE=$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1)
[ -z "$NODE" ] && NODE=$(command -v node)
[ -z "$NODE" ] && { echo "$(date) node not found" >> "$HOME/Grow/GrowSales/imports/done/import.log"; exit 1; }
cd "$HOME/Grow/GrowSales" || exit 1
echo "=== $(date) ===" >> imports/done/import.log
"$NODE" scripts/import-timetrack.mjs --scan >> imports/done/import.log 2>&1
