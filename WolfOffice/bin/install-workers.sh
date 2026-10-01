#!/bin/bash
# Writes and (re)loads a launchd job for every worker in workers/workers.json.
#
#   bin/install-workers.sh --dry-run   print every plist, load nothing, touch nothing
#   bin/install-workers.sh             write ~/Library/LaunchAgents/com.wolfoffice.<name>.plist and load it
#
# workers.json commands use placeholders so the file is machine independent:
#   __WOLFOFFICE__  this repo's folder (normally ~/Grow/WolfOffice)
#   __HOME__        $HOME
# Node is the one on PATH when you run this. Python is $GROW_PYTHON, else $LEADDESK_PYTHON,
# else python3 on PATH, else the old python.org 3.10 framework build if it exists.
set -euo pipefail

DRY=0
for a in "$@"; do
  case "$a" in
    --dry-run|-n) DRY=1 ;;
    -h|--help) sed -n '2,11p' "$0"; exit 0 ;;
    *) echo "unknown option: $a" >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
JSON="$ROOT/workers/workers.json"

# Only these jobs belong to Grow. Anything else in workers.json stops the install, so a
# stray personal or experimental entry never gets scheduled by accident.
ALLOW="analyst installs chaser payaudit mgrcards runner-grow chief-grow isp-i3 isp-slic isp-lyte isp-surf isp-tds isp-ezee isp-omni sales-lead slots-tds slots-surf"

command -v node >/dev/null || { echo "node not found on PATH" >&2; exit 1; }
NODE="$(command -v node)"
NODE_REAL="$(readlink -f "$NODE" 2>/dev/null || echo "$NODE")"
NODE_BIN="$(dirname "$NODE_REAL")"

PY="${GROW_PYTHON:-${LEADDESK_PYTHON:-}}"
if [ -z "$PY" ]; then PY="$(command -v python3 || true)"; fi
if [ -z "$PY" ] && [ -x /Library/Frameworks/Python.framework/Versions/3.10/bin/python3 ]; then
  PY=/Library/Frameworks/Python.framework/Versions/3.10/bin/python3
fi
PY_BIN=""
if [ -n "$PY" ]; then PY_BIN="$(dirname "$PY")"; fi
PATHV="${PY_BIN:+$PY_BIN:}$NODE_BIN:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"

bad="$(node -e '
const allow = new Set(process.argv[2].split(" "));
const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
console.log(j.workers.map(w => w.name).filter(n => !allow.has(n)).join(" "));
' "$JSON" "$ALLOW")"
if [ -n "$bad" ]; then
  echo "Refusing to install: workers.json has entries outside the Grow allowlist: $bad" >&2
  echo "Remove them, or add them to ALLOW in $0 if they really are Grow jobs." >&2
  exit 1
fi

if [ "$DRY" = 0 ]; then
  mkdir -p "$HOME/Library/Logs/wolfoffice" "$HOME/Library/LaunchAgents" "$HOME/bin"
  # office-wrap brackets every wrapped job; office-log is what scripts call to post an event.
  for b in office-wrap office-log; do
    chmod +x "$ROOT/bin/$b"
    ln -sfn "$ROOT/bin/$b" "$HOME/bin/$b"
    echo "linked ~/bin/$b -> $ROOT/bin/$b"
  done
else
  echo "# dry run: would link ~/bin/office-wrap and ~/bin/office-log to $ROOT/bin"
  echo "# node: $NODE_REAL   python: ${PY:-<none found>}"
fi

xml_escape() {
  # Escape &, <, > for safe inclusion inside an XML <string> element.
  printf '%s' "$1" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g'
}

subst() {
  # Fill the workers.json placeholders for this machine.
  local s="$1"
  s="${s//__WOLFOFFICE__/$ROOT}"
  s="${s//__HOME__/$HOME}"
  printf '%s' "$s"
}

node -e '
const j = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
for (const w of j.workers) console.log(JSON.stringify(w));
' "$JSON" | while read -r line; do
  name=$(echo "$line" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).name')
  agent=$(echo "$line" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).agent ?? ""')
  cmd=$(subst "$(echo "$line" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).cmd ?? ""')")
  interval=$(echo "$line" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).interval ?? ""')
  cal=$(echo "$line" | node -pe 'const w=JSON.parse(require("fs").readFileSync(0,"utf8")); w.calendar ? JSON.stringify(w.calendar) : ""')
  execv=$(subst "$(echo "$line" | node -pe 'const w=JSON.parse(require("fs").readFileSync(0,"utf8")); Array.isArray(w.exec) ? w.exec.join("\n") : ""')")
  label="com.wolfoffice.$name"; plist="$HOME/Library/LaunchAgents/$label.plist"

  # Build ProgramArguments as individual argv elements.
  # "exec": [binary, args...] runs that binary directly (a bare "node" becomes the resolved
  # node path), so macOS treats it, not bash, as the process asking for Full Disk Access.
  if [ -n "$execv" ]; then
    args=(); while IFS= read -r a; do if [ "$a" = node ]; then a="$NODE_REAL"; fi; args+=("$a"); done <<< "$execv"
  elif [ -n "$agent" ]; then
    args=("$HOME/bin/office-wrap" "$agent" "--status-from-last-line" "--" "/bin/bash" "-c" "$cmd")
  else
    args=("/bin/bash" "-c" "$cmd")
  fi

  body="$(
    echo '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>'
    echo "<key>Label</key><string>$label</string>"
    printf '<key>ProgramArguments</key><array>'
    for a in "${args[@]}"; do
      printf '<string>%s</string>' "$(xml_escape "$a")"
    done
    printf '</array>\n'
    if [ -n "$interval" ]; then echo "<key>StartInterval</key><integer>$interval</integer>"; fi
    if [ -n "$cal" ]; then
      # "calendar" is one {hour,minute,...} or a list of them (several runs a day).
      echo "<key>StartCalendarInterval</key>"
      echo "$cal" | node -pe 'const c=JSON.parse(require("fs").readFileSync(0,"utf8")); const d=(o)=>"<dict>"+Object.entries(o).map(([k,v])=>`<key>${k[0].toUpperCase()+k.slice(1)}</key><integer>${v}</integer>`).join("")+"</dict>"; Array.isArray(c) ? "<array>"+c.map(d).join("")+"</array>" : d(c)'
    fi
    printf '<key>EnvironmentVariables</key><dict><key>PATH</key><string>%s</string>' "$(xml_escape "$PATHV")"
    if [ -n "$PY" ]; then printf '<key>GROW_PYTHON</key><string>%s</string>' "$(xml_escape "$PY")"; fi
    echo "</dict>"
    echo "<key>StandardOutPath</key><string>$HOME/Library/Logs/wolfoffice/$name.log</string><key>StandardErrorPath</key><string>$HOME/Library/Logs/wolfoffice/$name.log</string>"
    echo '</dict></plist>'
  )"

  if [ "$DRY" = 1 ]; then
    echo "===== $plist"
    printf '%s\n' "$body"
    continue
  fi

  printf '%s\n' "$body" > "$plist"
  plutil -lint "$plist" >/dev/null
  launchctl unload "$plist" 2>/dev/null || true
  if launchctl load "$plist"; then
    echo "loaded $label"
  else
    echo "failed $label"
  fi
done
