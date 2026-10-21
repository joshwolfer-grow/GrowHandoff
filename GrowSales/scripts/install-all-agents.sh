#!/bin/bash
# Install EVERY Grow launchd job on this Mac from the templates in scripts/launchd/.
#
#   bash scripts/install-all-agents.sh --dry-run   # print the rewritten plists, load nothing
#   bash scripts/install-all-agents.sh             # install / reinstall all of them
#   bash scripts/install-all-agents.sh sr-sync rtr-sync   # just these
#   bash scripts/install-all-agents.sh --list      # what is installed, last exit code
#   bash scripts/install-all-agents.sh --remove    # unload and delete them
#
# install-agents.sh only covers the three knock crawls. This one covers all seven
# jobs and rewrites every machine-specific part of a template on the way in:
#   - any /Users/<name>/.../GrowSales or REPLACE_HOME/Grow/GrowSales -> this repo
#   - the nvm node dir                -> the node this shell resolves
#   - the python.org 3.10 framework dir -> the python3 this shell resolves
#   - /Users/<name>/                  -> $HOME/
#   - ~/bin/office-wrap (WolfOffice)  -> dropped when WolfOffice is not installed
# and refuses to load a plist that still names another user's home.
set -euo pipefail
cd "$(dirname "$0")/.." || exit 1
ROOT="$(pwd)"
LA="$HOME/Library/LaunchAgents"
ALL=(sr-sync amplify-sync rtr-sync isp-export isp-intake ezee-addresses)

NODE_BIN="$(command -v node || true)"
[ -z "$NODE_BIN" ] && NODE_BIN="$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1)"
[ -z "$NODE_BIN" ] && { echo "No node found. Install node 20 (nvm), then re-run." >&2; exit 1; }
NODE_DIR="$(dirname "$NODE_BIN")"
PY_BIN="/Library/Frameworks/Python.framework/Versions/3.10/bin/python3"
[ -x "$PY_BIN" ] || PY_BIN="$(command -v python3)"
PY_DIR="$(dirname "$PY_BIN")"

DRY=0; WANT=()
for a in "$@"; do
  case "$a" in
    --dry-run) DRY=1;;
    --list)
      printf '%-28s %-8s %s\n' JOB LOADED LAST_EXIT
      for j in "${ALL[@]}"; do
        line=$(launchctl list 2>/dev/null | awk -v l="com.grow.$j" '$3==l')
        printf '%-28s %-8s %s\n' "com.grow.$j" "$([ -n "$line" ] && echo yes || echo no)" "$(echo "$line" | awk '{print $2}')"
      done; exit 0;;
    --remove)
      for j in "${ALL[@]}"; do
        launchctl unload "$LA/com.grow.$j.plist" 2>/dev/null || true
        rm -f "$LA/com.grow.$j.plist"; echo "removed com.grow.$j"
      done; exit 0;;
    *) WANT+=("$a");;
  esac
done
[ ${#WANT[@]} -eq 0 ] && WANT=("${ALL[@]}")

mkdir -p "$LA" imports/done imports/isp
echo "repo:   $ROOT"
echo "node:   $NODE_DIR"
echo "python: $PY_DIR"
for j in "${WANT[@]}"; do
  src="scripts/launchd/com.grow.$j.plist"
  [ -f "$src" ] || { echo "  skip $j (no $src)"; continue; }
  out="$(mktemp)"
  sed -E \
    -e "s#REPLACE_HOME/Grow/GrowSales#$ROOT#g" \
    -e "s#/Users/[^/<]+(/Desktop)?/Grow/GrowSales#$ROOT#g" \
    -e "s#/Users/[^/<]+/\.nvm/versions/node/[^/<:]+/bin#__NODE_DIR__#g" \
    -e "s#/Library/Frameworks/Python\.framework/Versions/3\.10/bin/python3#__PY_BIN__#g" \
    -e "s#/Library/Frameworks/Python\.framework/Versions/3\.10/bin#__PY_DIR__#g" \
    -e "s#/Users/[^/<]+/#$HOME/#g" \
    -e "s#__NODE_DIR__#$NODE_DIR#g" -e "s#__PY_BIN__#$PY_BIN#g" -e "s#__PY_DIR__#$PY_DIR#g" \
    "$src" > "$out"
  if [ ! -x "$HOME/bin/office-wrap" ] && grep -q 'office-wrap' "$out"; then
    # Drop the WolfOffice wrapper and its arguments up to and including "--".
    python3 - "$out" <<'PY'
import re, sys
p = sys.argv[1]; s = open(p).read()
s = re.sub(r'\s*<string>[^<]*office-wrap</string>(\s*<string>[^<]*</string>)*?\s*<string>--</string>', '', s)
open(p, 'w').write(s)
PY
  fi
  if grep -qE "<string>/Users/" "$out" && grep -E "<string>/Users/" "$out" | grep -vq "$HOME"; then
    echo "  !! com.grow.$j still names another user's folder; not loading:" >&2
    grep -nE "<string>/Users/" "$out" | grep -v "$HOME" >&2
    rm -f "$out"; continue
  fi
  plutil -lint -s "$out" || { echo "  !! com.grow.$j is not a valid plist" >&2; rm -f "$out"; continue; }
  if [ $DRY = 1 ]; then
    echo "----- com.grow.$j"; grep -E '<string>' "$out" | grep -v '<key>Hour' | sed 's/^ */  /'; rm -f "$out"; continue
  fi
  mv "$out" "$LA/com.grow.$j.plist"
  launchctl unload "$LA/com.grow.$j.plist" 2>/dev/null || true
  launchctl load "$LA/com.grow.$j.plist"
  echo "  installed com.grow.$j"
done

[ $DRY = 1 ] && exit 0
echo
echo "Check with: bash scripts/install-all-agents.sh --list"
echo "The knock crawls only move data once their logins are seeded (see SETUP.md)."
