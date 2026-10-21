#!/bin/bash
# Exit 0 if a crawler is paused from the dashboard, 1 if it should run.
#
#   bash scripts/paused.sh <key> && { echo "paused"; exit 0; }
#
# The Pause button on the sync popover (Live badge) writes report_config row
# __paused__ = {"<key>": {"at": ...}, ...}; Resume deletes the key. Keys are the
# board row keys: sr, tds, isp, rtr_<source>. A paused runner skips the run and
# writes no marker, so it never goes red and never emails.
#
# Fails OPEN: if Supabase can't be reached the crawler runs. A network blip must
# never silently stop a sync.
cd "$(dirname "$0")/.." || exit 1
KEY=$(grep -oE 'eyJ[A-Za-z0-9_.-]{50,}' index.html 2>/dev/null | head -1)
[ -z "$KEY" ] && exit 1
J=$(curl -s -m 8 "https://cmkfohwbejcztctrpdnt.supabase.co/rest/v1/report_config?select=config&manager=eq.__paused__" \
  -H "apikey: $KEY" -H "Authorization: Bearer $KEY" 2>/dev/null)
printf '%s' "$J" | grep -q "\"$1\":" && exit 0
exit 1
