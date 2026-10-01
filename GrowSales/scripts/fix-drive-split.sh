#!/bin/bash
# Undo the Sep 14 Drive split: the frozen "<name> 2.xlsx" is the file each ISP has a
# link to, so give it back the canonical name, park the unshared one as
# "(unshared copy)", pin its Drive id, then rebuild. Nothing is deleted.
# Usage: bash scripts/fix-drive-split.sh [ISP ...]   (default: every ISP with a " 2")
cd "$(dirname "$0")/.." || exit 1
. scripts/_drive.sh
ROOT="$GROW_DRIVE/Reporting/SalesRabbit Reports For ISPs"
ISPS=("$@"); [ ${#ISPS[@]} -eq 0 ] && ISPS=(i3 SLIC Glo GBN Surf Lyte GFiber NLF)

for d in "${ISPS[@]}"; do
  b="$ROOT/$d/Grow & $d Knocking Data"
  if [ ! -f "$b 2.xlsx" ]; then echo "  $d: no split"; continue; fi
  if [ -e "$b (unshared copy).xlsx" ]; then echo "  $d: an (unshared copy) already exists, skipping"; continue; fi
  mv -n "$b.xlsx" "$b (unshared copy).xlsx" && mv -n "$b 2.xlsx" "$b.xlsx" || { echo "  $d: rename failed"; continue; }
  id=$(xattr -p 'com.google.drivefs.item-id#S' "$b.xlsx")
  python3 - "$d" "$id" <<'PY'
import json, sys
p = 'data/isp-drive-ids.json'
j = json.load(open(p)); j[sys.argv[1]] = sys.argv[2]
json.dump(j, open(p, 'w'), indent=2); open(p, 'a').write('\n')
PY
  echo "  $d: fixed, pinned $id"
done

echo "Rebuilding..."
ISP_FORCE=1 bash scripts/run-isp-export.sh
tail -1 imports/done/isp-export.log
