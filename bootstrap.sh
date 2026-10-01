#!/bin/bash
# Set up the Grow systems on a new Mac. Run each step in order; every step is
# safe to re-run. The repo must be cloned to ~/Grow (paths across the scripts
# and skills assume ~/Grow/GrowSales).
#
#   bash bootstrap.sh check              # what's installed, what's missing
#   bash bootstrap.sh install            # npm + pip deps, skills, env file templates
#   bash bootstrap.sh data <archive>     # unpack the grow-data-*.tar.gz from the previous owner
#   bash bootstrap.sh logins             # prints the sign-in steps (each opens a browser)
#   bash bootstrap.sh jobs               # install the 7 scheduled launchd jobs
#   bash bootstrap.sh verify             # health check of jobs, tokens, Drive, Vercel
#   bash bootstrap.sh wolfoffice         # OPTIONAL: the WolfOffice status layer
set -uo pipefail
G="$HOME/Grow"
GS="$G/GrowSales"
ok()   { printf '  \033[32mok\033[0m    %s\n' "$*"; }
miss() { printf '  \033[31mMISSING\033[0m %s\n' "$*"; MISSING=1; }
warn() { printf '  \033[33mwarn\033[0m  %s\n' "$*"; }
MISSING=0

here="$(cd "$(dirname "$0")" && pwd)"
if [ "$here" != "$G" ]; then
  echo "This repo is at $here but must be at $G."
  echo "Move it:  mv \"$here\" \"$G\"   (or re-clone into ~/Grow), then re-run."
  exit 1
fi

node_bin() { command -v node || ls -d "$HOME"/.nvm/versions/node/*/bin/node 2>/dev/null | sort -V | tail -1; }

step_check() {
  echo "== Tools"
  xcode-select -p >/dev/null 2>&1 && ok "Xcode command line tools" || miss "Xcode tools: xcode-select --install"
  command -v brew >/dev/null && ok "Homebrew" || warn "Homebrew not found (optional, handy for the rest): https://brew.sh"
  NB="$(node_bin)"
  if [ -n "$NB" ]; then
    v=$("$NB" -v); case "$v" in v20*|v22*) ok "node $v";; *) warn "node $v (built and tested on v20)";; esac
  else miss "node 20: install nvm (https://github.com/nvm-sh/nvm) then: nvm install 20"; fi
  if command -v python3 >/dev/null; then
    pv=$(python3 -c 'import sys;print("%d.%d"%sys.version_info[:2])')
    python3 -c 'import sys;sys.exit(0 if sys.version_info>=(3,10) else 1)' && ok "python $pv" || miss "python >= 3.10 (python.org installer)"
  else miss "python3 >= 3.10 (python.org installer)"; fi
  [ -d "/Applications/Google Chrome.app" ] && ok "Google Chrome (the scrapers drive it)" || miss "Google Chrome"
  ls -d "$HOME"/Library/CloudStorage/GoogleDrive-*/"Shared drives/Grow - Corporate" >/dev/null 2>&1 \
    && ok "Google Drive: Grow - Corporate shared drive mounted" \
    || miss "Google Drive for Desktop, signed in, with access to the 'Grow - Corporate' shared drive"
  command -v vercel >/dev/null && ok "vercel CLI" || miss "vercel CLI: npm i -g vercel"
  command -v claude >/dev/null && ok "Claude Code CLI" || warn "Claude Code CLI not on PATH (the desktop app is fine too)"
  echo
  echo "== Secrets present (values not shown)"
  for f in GrowSales/.env.local GrowSales/.env.prod GrowSales/.env.bria GrowSales/.env.install-slots \
           RepText/.env TrainingVideos/.env GrowSales/data/.sector-map-key GrowSales/data/.sequifi-token; do
    [ -s "$G/$f" ] && ok "$f" || warn "$f not filled in yet (see GrowSales/.env.example)"
  done
  for f in .geocodio.env .terros.env; do [ -s "$HOME/$f" ] && ok "~/$f" || warn "~/$f not filled in yet"; done
  echo
  [ $MISSING = 0 ] && echo "All required tools present." || echo "Install the MISSING items, then re-run: bash bootstrap.sh check"
}

step_install() {
  NB="$(node_bin)"; [ -z "$NB" ] && { echo "Install node first (bash bootstrap.sh check)."; exit 1; }
  export PATH="$(dirname "$NB"):$PATH"
  echo "== npm (GrowSales)"; (cd "$GS" && npm ci --no-audit --no-fund) || exit 1
  echo "== pip"; python3 -m pip install --user -r "$GS/requirements.txt" || exit 1
  echo "== Skills -> ~/.claude/skills (so they work from any folder)"
  mkdir -p "$HOME/.claude/skills"
  for s in "$G"/.claude/skills/*/; do
    n=$(basename "$s"); ln -sfn "$s" "$HOME/.claude/skills/$n"; ok "skill $n"
  done
  echo "== Env file templates (names only, fill the values from the password manager)"
  for f in .env.local .env.prod .env.bria .env.install-slots; do
    [ -e "$GS/$f" ] && ok "GrowSales/$f exists" || { : > "$GS/$f"; warn "created empty GrowSales/$f"; }
  done
  [ -e "$G/RepText/.env" ] || { echo 'GROW_ACCESS_CODE=' > "$G/RepText/.env"; warn "created RepText/.env"; }
  [ -e "$G/TrainingVideos/.env" ] || { printf 'PEXELS_API_KEY=\nGEMINI_API_KEY=\nGEMINI_IMAGE_MODEL=\n' > "$G/TrainingVideos/.env"; warn "created TrainingVideos/.env"; }
  mkdir -p "$GS/imports/done" "$GS/imports/isp" "$GS/data"
  echo
  echo "Next: put the values in (GrowSales/.env.example says which name goes in which file),"
  echo "then: bash bootstrap.sh data <archive>"
}

step_data() {
  a="${1:-}"; [ -f "$a" ] || { echo "usage: bash bootstrap.sh data ~/Downloads/grow-data-YYYY-MM-DD.tar.gz"; exit 1; }
  echo "Unpacking $a into $G ..."
  tar -xzf "$a" -C "$G" && ok "unpacked"
  for f in sr-store.jsonl sr-leads.jsonl isp-imports.json; do
    [ -s "$GS/data/$f" ] && ok "data/$f ($(du -h "$GS/data/$f" | cut -f1))" || miss "data/$f"
  done
  echo "Delete the archive once this says ok: it holds customer addresses."
}

step_logins() {
  cat <<'EOF'
Each of these opens a Chrome window. Sign in with YOUR account for that service,
then close the window when the script says it captured the session.

  cd ~/Grow/GrowSales
  node scripts/grow-sync.mjs --seed                         # SalesRabbit (main tenant)
  node scripts/rtr-sync.mjs --login                         # Opendoor / Realtime Results (Ezee, Bluepeak, Omni)
  node scripts/amplify-company-sync.mjs --source tds --login  # Amplify (TDS)
  node scripts/install-slots.mjs --login --isp surf         # Surf portal, only if slots are kept
  node scripts/_diag-tds.mjs                                # TDS's old SalesRabbit: sign in, wait for
                                                            # "TOKEN SAVED", then Ctrl+C
  vercel login && vercel link                               # pick the Grow team + project
  vercel env ls                                             # confirm you can see the project env

When every login works, run: bash bootstrap.sh jobs
EOF
}

step_jobs() {
  NB="$(node_bin)"; export PATH="$(dirname "$NB"):$PATH"
  bash "$GS/scripts/install-all-agents.sh" --dry-run >/dev/null || { echo "dry run failed"; exit 1; }
  bash "$GS/scripts/install-all-agents.sh"
  echo
  echo "If a job needs to read ~/Library/Messages or a protected folder, macOS will ask."
  echo "Grant Full Disk Access to /bin/bash, node and python3 in System Settings > Privacy."
}

step_verify() {
  echo "== Scheduled jobs"; bash "$GS/scripts/install-all-agents.sh" --list
  echo; echo "== Tokens"
  [ -s "$GS/data/sr-auth.json" ] && ok "SalesRabbit token" || miss "SalesRabbit token: node scripts/grow-sync.mjs --seed"
  echo; echo "== Last sync log lines"
  for l in sr-sync rtr-sync amplify-sync isp-export isp-intake; do
    f="$GS/imports/done/$l.log"; [ -f "$f" ] && echo "  $l: $(tail -1 "$f" | cut -c1-120)" || warn "$l: no log yet"
  done
  echo; echo "== Vercel"
  (cd "$GS" && vercel whoami 2>/dev/null) && ok "vercel signed in" || miss "vercel login"
  [ -f "$GS/.vercel/project.json" ] && ok "project linked" || miss "cd GrowSales && vercel link"
  echo; echo "Also open the dashboard > More > Admin > health board: every row should be green within a day."
}

step_wolfoffice() {
  echo "WolfOffice is optional: the GrowSales jobs run without it."
  echo "Read WolfOffice/README.md first, then:"
  echo "  cd ~/Grow/WolfOffice && npm ci && cp .env.example .env   # fill OFFICE_SUPABASE_URL / OFFICE_SERVICE_KEY"
  echo "  bash bin/install-workers.sh --dry-run    # check, then without --dry-run"
}

case "${1:-}" in
  check) step_check;; install) step_install;; data) step_data "${2:-}";;
  logins) step_logins;; jobs) step_jobs;; verify) step_verify;; wolfoffice) step_wolfoffice;;
  *) sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//';;
esac
