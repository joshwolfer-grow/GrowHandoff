#!/bin/bash
# Write a sync status marker the dashboard can read (Admin · Ops health board).
#
#   bash scripts/sync-marker.sh <name> <ok|fail> [detail] [fix] [cadence]
#
# Upserts report_config row manager="__<name>__" with {ran_at, ok, detail, fix,
# cadence}. `cadence` is free text ("daily", "every 30 min") and exists because
# sources under one runner no longer share a schedule: omni pulls once a day
# while ezee and bluepeak pull every 30 min. Without it the health board measures
# every row against the agent's interval and paints a daily source amber for 23
# of every 24 hours.
# `fix` is the exact command that clears this failure. The runner is the only
# thing that knows WHICH failure it hit — an expired token needs --seed, a
# crashed run just needs re-running — so it names the command instead of making
# the dashboard guess from the message. The card renders it with a Copy button.
# Same pattern as the __knock_sync__ marker grow-sync.mjs writes itself; this
# helper exists so the bash runners (rtr, amplify) can report too, including
# FAILURES — a launchd job that dies silently is exactly what the board is for.
#
# Never fails the caller: the marker is cosmetic, the sync result is what counts.
cd "$(dirname "$0")/.." || exit 0
# Email on failure / recovery (state changes only). Backgrounded so SMTP can
# never slow or fail the sync. Replaces the old per-runner Mac banners.
/usr/bin/python3 scripts/alert-email.py "$1" "$2" "${3:-}" "${4:-}" "${5:-}" >/dev/null 2>&1 &
KEY=$(grep -oE 'eyJ[A-Za-z0-9_.-]{50,}' index.html 2>/dev/null | head -1)
[ -z "$KEY" ] && exit 0
NAME="__${1}__"
OK=$([ "$2" = "ok" ] && echo true || echo false)
DETAIL=$(printf '%s' "${3:-}" | tr '\n' ' ' | sed 's/["\\]//g' | cut -c1-300)
FIX=$(printf '%s' "${4:-}" | tr '\n' ' ' | sed 's/["\\]//g' | cut -c1-200)
CADENCE=$(printf '%s' "${5:-}" | tr '\n' ' ' | sed 's/["\\]//g' | cut -c1-40)
curl -s -m 10 -X POST "https://cmkfohwbejcztctrpdnt.supabase.co/rest/v1/report_config?on_conflict=manager" \
  -H "apikey: $KEY" -H "Authorization: Bearer $KEY" -H "Content-Type: application/json" \
  -H "Prefer: resolution=merge-duplicates,return=minimal" \
  -d "[{\"manager\":\"$NAME\",\"config\":{\"ran_at\":\"$(date -u +%Y-%m-%dT%H:%M:%SZ)\",\"ok\":$OK,\"detail\":\"$DETAIL\",\"fix\":\"$FIX\",\"cadence\":\"$CADENCE\"}}]" >/dev/null 2>&1
exit 0
