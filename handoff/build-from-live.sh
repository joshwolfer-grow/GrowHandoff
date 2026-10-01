#!/bin/bash
# Refresh this handoff repo from the live projects on the previous owner's Mac.
# Run it again on the last day so the successor gets the newest code.
#
#   bash handoff/build-from-live.sh
#
# What it copies:
#   GrowSales       exactly the files git would accept in the live repo (its
#                   .gitignore already keeps out secrets, PII, data and backups)
#   RepText         scripts and templates only (no .env, no CSVs: those hold phone numbers)
#   TrainingVideos  PIPELINE.md, scripts/, decks/ (footage and renders go via Drive)
#   skills          the Grow skills from ~/.claude and the claude.ai synced folder
#
# WolfOffice is NOT refreshed here. It was copied once and stripped of personal
# code by hand; re-copying would bring the personal parts back.
set -euo pipefail

LIVE="$HOME/Grow"
OUT="$(cd "$(dirname "$0")/.." && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

echo "== GrowSales"
( cd "$LIVE/GrowSales"
  git ls-files --cached --others --exclude-standard | while IFS= read -r f; do
    [ -f "$f" ] && printf '%s\n' "$f"
  done | grep -vE '^api/rep-identity-seed' ) > "$TMP/gs.txt"
rm -rf "$OUT/GrowSales.new"
rsync -a --files-from="$TMP/gs.txt" "$LIVE/GrowSales/" "$OUT/GrowSales.new/"
rm -rf "$OUT/GrowSales"; mv "$OUT/GrowSales.new" "$OUT/GrowSales"
echo "   $(wc -l < "$TMP/gs.txt" | tr -d ' ') files"

echo "== RepText"
rsync -a --delete \
  --exclude '.env*' --exclude '*.csv' --exclude '*.bak*' --exclude '.DS_Store' \
  --exclude 'vet-tier*' --exclude '__pycache__' \
  "$LIVE/RepText/" "$OUT/RepText/"

echo "== TrainingVideos"
mkdir -p "$OUT/TrainingVideos"
rsync -a --delete --exclude '.DS_Store' --exclude '.env*' --exclude '*.bak*' \
  --exclude '__pycache__' \
  --include 'PIPELINE.md' --include 'scripts/***' --include 'decks/***' --exclude '*' \
  "$LIVE/TrainingVideos/" "$OUT/TrainingVideos/"

echo "== skills"
SYNCED="$(ls -d "$HOME"/.claude/skills/synced/*/ 2>/dev/null | head -1)"
for s in "$SYNCED/grow-training-deck" "$SYNCED/leads-dedup" \
         "$HOME/.claude/skills/isp-leads" "$HOME/.claude/skills/sequifi-roster-check" \
         "$LIVE/GrowSales/.claude/skills/"*; do
  [ -d "$s" ] && rsync -a --delete --exclude '.DS_Store' "$s" "$OUT/.claude/skills/"
done
ls "$OUT/.claude/skills"

echo "== secret scan"
bash "$OUT/handoff/scan-secrets.sh"
