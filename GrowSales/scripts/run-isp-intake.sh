#!/bin/bash
# Drop-folder watcher for ISP lead files (launchd: com.grow.isp-intake, every 5 min).
#
# Anything you (or a Mail rule) drop into imports/isp/ gets run through
# scripts/isp-intake.py: ISP detected, raw file archived to Drive, SalesRabbit
# import built and deduped, result posted as a Mac notification. Files that
# need a decision (unknown ISP, or no rep to assign to) move to imports/isp/parked
# and the notification says what to rerun.
#
# A rep is required to build the import and there is no safe default, so the
# watcher passes none: every file parks after archiving until you run
#   python3 scripts/isp-intake.py "imports/isp/parked/<file>" --assign "<rep>"
# unless ISP_DEFAULT_REP is set in the plist, in which case that rep gets it.
cd "$(dirname "$0")/.." || exit 1
PY=/Library/Frameworks/Python.framework/Versions/3.10/bin/python3
[ -x "$PY" ] || PY=$(command -v python3)
LOG=imports/done/isp-intake.log
mkdir -p imports/isp/done imports/isp/ready imports/isp/parked imports/done
# ls with several globs fails if ANY pattern has no match, so test with find.
# office-wrap / office-log come from WolfOffice and are optional: without them
# the intake still runs, it just doesn't report to the office board.
WRAP=(); [ -x "$HOME/bin/office-wrap" ] && WRAP=("$HOME/bin/office-wrap" courier --)
beat() { [ -x "$HOME/bin/office-log" ] && "$HOME/bin/office-log" beat courier >/dev/null; return 0; }
[ -n "$(find imports/isp -maxdepth 1 -type f \( -iname '*.xlsx' -o -iname '*.xlsm' -o -iname '*.csv' \) ! -name '~$*' | head -1)" ] || { beat; exit 0; }
echo "=== $(date) ===" >> "$LOG"
# Archive + park only. The formatting, dedupe and import build go through Claude
# (isp-leads skill) so a change in an ISP's file layout is looked at, not
# pushed through a header-matching script.
${WRAP[@]+"${WRAP[@]}"} "$PY" scripts/isp-intake.py --inbox --quiet --archive-only >> "$LOG" 2>&1
