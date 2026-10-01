#!/bin/bash
# Build the TDS sector map from TDS's own SalesRabbit company.
#   1. crawl TDS's SalesRabbit (classic platform) with scripts/tds-sr-sync.mjs -> data/tds-*
#   2. doors with GPS -> data/osm-cache/TDS-doors.json
#   3. first time only: roads + the frozen Grow cut (data/sectors/TDS-cut.json)
#   4. draw + upload to sector_maps, which More > ISP Maps reads
# Token first: data/sr-auth-tds.json, captured from a signed-in TDS web.salesrabbit.com window (see tds-sr-sync.mjs)
set -e
cd "$(dirname "$0")/.."
[ -f data/sr-auth-tds.json ] || { echo "No TDS token (data/sr-auth-tds.json). Sign in to TDS SalesRabbit in a recorder window first."; exit 3; }
node scripts/tds-sr-sync.mjs
python3 scripts/sector-build.py TDS --extract
if [ ! -f data/sectors/TDS-cut.json ]; then
  python3 scripts/osm-fetch.py TDS
  python3 scripts/sector-build.py TDS --cut
fi
python3 scripts/sector-maps.py TDS --no-extract
