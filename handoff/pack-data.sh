#!/bin/bash
# Bundle the live state git cannot carry into one archive for the successor.
# Run on the previous owner's Mac, ideally on the last day:
#
#   bash handoff/pack-data.sh                 # -> ~/Desktop/grow-data-YYYY-MM-DD.tar.gz
#   bash handoff/pack-data.sh /some/folder    # write it there instead
#
# Unpack on the new Mac from inside the repo:
#   tar -xzf grow-data-YYYY-MM-DD.tar.gz -C ~/Grow
#
# INCLUDED: the crawl stores and every small file that is not regenerable
# (isp-imports.json above all), the imports/ queue and its state stamps.
# EXCLUDED on purpose:
#   - *.pre-* / backup-* / dedupe-backup-* copies (~3.3 GB of old snapshots)
#   - regenerable CSVs (a full `node scripts/grow-sync.mjs` rebuilds them)
#   - every token and key file (sr-auth*.json, *-lead-endpoint.json,
#     .sector-map-key, .env*) and every browser profile. Those are credentials:
#     they go through the password manager or get re-seeded with a fresh login.
# The archive still holds customer addresses. Send it by AirDrop or a
# restricted Drive link, never a public one, and delete it once unpacked.
set -euo pipefail
GS="$HOME/Grow/GrowSales"
OUT_DIR="${1:-$HOME/Desktop}"
OUT="$OUT_DIR/grow-data-$(date +%F).tar.gz"
cd "$HOME/Grow"

LIST="$(mktemp)"; trap 'rm -f "$LIST"' EXIT
add() { for p in "$@"; do [ -e "$p" ] && printf '%s\n' "$p" >> "$LIST"; done; return 0; }

# Crawl stores + watermarks
add GrowSales/data/sr-store.jsonl GrowSales/data/sr-leads.jsonl GrowSales/data/sr-sync-state.json
add GrowSales/data/tds-store.jsonl GrowSales/data/tds-leads.jsonl
# Not regenerable, or slow/throttled to rebuild
add GrowSales/data/isp-imports.json GrowSales/data/isp-drive-ids.json GrowSales/data/rep-emails.json
add GrowSales/data/kc-frozen-repdays.json GrowSales/data/sr-import-cities.json
add GrowSales/data/install-slots.jsonl GrowSales/data/install-slot-probes.json
add GrowSales/data/sectors GrowSales/data/terros-schema.csv GrowSales/data/merch-2026.json
add GrowSales/data/osm-cache
# ISP field guide source (scripts/build_guide_site.py reads these)
add GrowSales/data/guide-text GrowSales/data/guide-tocs.json GrowSales/data/isp-field-guide.html
add GrowSales/data/HOW-TO-build-a-guide-page.md GrowSales/data/ISP-FIELD-QA.md GrowSales/data/ISP-QA-HANDOFF.md
add GrowSales/data/isp-guide-conflicts.md GrowSales/data/isp-guide-faqs.md GrowSales/data/isp-guide-heading-checklist.md
add GrowSales/data/by-isp GrowSales/data/by-isp-qa GrowSales/data/_market
# Intake queue and the state stamps the schedulers read (mail dedupe, sealed days)
add GrowSales/imports/isp GrowSales/imports/done/mail-leads-seen.txt
add GrowSales/imports/done/rtr-last-sealed GrowSales/imports/done/rtr-last-daily-omni
add GrowSales/imports/done/isp-export-last-run
# Training video sources are too big for this archive: share TrainingVideos/
# footage, assets, work and output through a Drive folder instead.

echo "Packing $(wc -l < "$LIST" | tr -d ' ') paths:"
sed 's/^/  /' "$LIST"
# Never let a credential ride along inside a copied folder.
tar -czf "$OUT" --exclude '*.pre-*' --exclude '*.bak*' --exclude 'sr-auth*' \
    --exclude '*-lead-endpoint.json' --exclude '.sector-map-key' --exclude '.env*' \
    -T "$LIST"
echo
echo "Wrote $OUT ($(du -h "$OUT" | cut -f1))"
