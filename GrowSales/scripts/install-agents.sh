#!/bin/bash
# Install the Grow sync launch agents on THIS machine.
#
#   bash scripts/install-agents.sh          # install / reinstall all agents
#   bash scripts/install-agents.sh --list   # show what is installed and running
#   bash scripts/install-agents.sh --remove # unload and remove them
#
# Why this exists: the plists in scripts/launchd/ carry an absolute path to the
# repo and to a specific nvm node build, because launchd has no shell and no
# $HOME expansion in ProgramArguments. Hardcoding worked while there was one
# Mac. On a new laptop — different username, different node version, repo in a
# different folder — every one of those agents fails silently, which looks
# exactly like "the data just stopped updating".
#
# So the checked-in plists stay readable as documentation, and this script
# rewrites the two machine-specific bits on the way into ~/Library/LaunchAgents.
# Run it once per machine. Nothing else needs editing.

set -euo pipefail
cd "$(dirname "$0")/.." || exit 1
ROOT="$(pwd)"
LA="$HOME/Library/LaunchAgents"
AGENTS=(com.grow.sr-sync com.grow.amplify-sync com.grow.rtr-sync)

# Resolve a node that launchd can reach. `command -v node` is whatever this
# shell has; the launchd job gets no profile, so the PATH must be absolute.
NODE_BIN="$(command -v node || true)"
[ -z "$NODE_BIN" ] && NODE_BIN="$(ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1)"
if [ -z "$NODE_BIN" ]; then
  echo "No node found. Install node (nvm or brew), then re-run." >&2
  exit 1
fi
NODE_DIR="$(dirname "$NODE_BIN")"

case "${1:-}" in
  --list)
    printf '%-24s %-8s %s\n' AGENT LOADED SCHEDULE
    for a in "${AGENTS[@]}"; do
      loaded=$(launchctl list 2>/dev/null | grep -c "$a" || true)
      sched=""
      if [ -f "$LA/$a.plist" ]; then
        iv=$(/usr/libexec/PlistBuddy -c "Print :StartInterval" "$LA/$a.plist" 2>/dev/null || true)
        [ -n "$iv" ] && sched="every ${iv}s"
        [ -z "$sched" ] && sched="calendar"
      else sched="NOT INSTALLED"; fi
      printf '%-24s %-8s %s\n' "$a" "$([ "$loaded" != 0 ] && echo yes || echo no)" "$sched"
    done
    exit 0;;
  --remove)
    for a in "${AGENTS[@]}"; do
      launchctl unload "$LA/$a.plist" 2>/dev/null || true
      rm -f "$LA/$a.plist"
      echo "removed $a"
    done
    exit 0;;
esac

mkdir -p "$LA" imports/done
echo "repo: $ROOT"
echo "node: $NODE_DIR"
for a in "${AGENTS[@]}"; do
  src="scripts/launchd/$a.plist"
  [ -f "$src" ] || { echo "  skip $a (no $src)"; continue; }
  # Rewrite both machine-specific bits: the baked-in repo path and the node dir
  # at the head of PATH.
  #
  # The repo rewrite anchors on the path SUFFIX (/scripts/run-*.sh,
  # /imports/done/*) rather than on "…/Grow/GrowSales", so it does not care what
  # the folder is called or where it lives on the new machine. -E because BSD
  # sed does not support \? in a basic regex — an earlier version used it and
  # silently left the old path in place, which is the exact failure this script
  # is meant to prevent.
  sed -E -e "s#<string>/[^<]*/scripts/(run-[^<]*\.sh)</string>#<string>$ROOT/scripts/\1</string>#g" \
         -e "s#<string>/[^<]*/imports/done/([^<]*)</string>#<string>$ROOT/imports/done/\1</string>#g" \
         -e "s#/Users/[^/]*/\.nvm/versions/node/[^/]*/bin#$NODE_DIR#g" \
         "$src" > "$LA/$a.plist"
  # Refuse to install an agent that still points somewhere else — a wrong path
  # here fails silently forever.
  if grep -q "<string>/Users/" "$LA/$a.plist" && ! grep -q "$ROOT" "$LA/$a.plist"; then
    echo "  !! $a still has a foreign path after rewrite; not loading" >&2
    rm -f "$LA/$a.plist"; continue
  fi
  launchctl unload "$LA/$a.plist" 2>/dev/null || true
  launchctl load "$LA/$a.plist"
  echo "  installed $a"
done

echo
echo "Installed. Check with: bash scripts/install-agents.sh --list"
echo "These only move data once their logins are seeded — see SETUP.md:"
echo "  node scripts/grow-sync.mjs --seed              # SalesRabbit token"
echo "  node scripts/rtr-sync.mjs --login              # Opendoor SSO"
echo "  node scripts/amplify-company-sync.mjs --source tds --login"
