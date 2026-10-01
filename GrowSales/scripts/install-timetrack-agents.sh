#!/bin/bash
# One-time install of the two Time Track launch agents:
#   • folder watcher  — auto-imports any CSV dropped in imports/
#   • weekday reminder — 9am Mon–Fri notification to pull the report
# Re-run any time to update. Uninstall: launchctl bootout gui/$UID/<label>.
set -e
SRC="$HOME/Grow/GrowSales/scripts/launchd"
DEST="$HOME/Library/LaunchAgents"
mkdir -p "$DEST"
chmod +x "$HOME/Grow/GrowSales/scripts/run-timetrack-scan.sh"

for label in com.grow.timetrack-import com.grow.timetrack-reminder; do
  sed "s#REPLACE_HOME#$HOME#g" "$SRC/$label.plist" > "$DEST/$label.plist"
  launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$DEST/$label.plist"
  echo "loaded $label"
done
# Desktop shortcut → the drop folder, so files are one drag from Downloads.
ln -sfn "$HOME/Grow/GrowSales/imports" "$HOME/Desktop/⬆ Drop Time Track"
echo "Made Desktop shortcut '⬆ Drop Time Track'."
echo "Done. Drag a Time Track CSV onto that shortcut to test — it imports itself."
