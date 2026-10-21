#!/bin/bash
# Oct 21 2026 trim: stop the jobs the owner no longer uses. Safe to re-run.
# Unloads them from launchd and parks the plists in ~/Library/LaunchAgents/disabled-grow/
# (nothing is deleted; move a plist back and `launchctl bootstrap` it to revive).
set -u
LA="$HOME/Library/LaunchAgents"
mkdir -p "$LA/disabled-grow"
for p in \
  com.grow.mail-leads \
  com.wolfoffice.analyst com.wolfoffice.installs com.wolfoffice.chaser \
  com.wolfoffice.sales-lead com.wolfoffice.chief-grow \
  com.wolfoffice.isp-i3 com.wolfoffice.isp-slic com.wolfoffice.isp-lyte \
  com.wolfoffice.isp-surf com.wolfoffice.isp-tds com.wolfoffice.isp-ezee com.wolfoffice.isp-omni
do
  if [ -f "$LA/$p.plist" ]; then
    launchctl bootout "gui/$(id -u)/$p" 2>/dev/null
    mv "$LA/$p.plist" "$LA/disabled-grow/" && echo "retired  $p"
  else
    echo "already  $p"
  fi
done
echo
echo "Still loaded:"
launchctl list | grep -E 'com\.grow|com\.wolfoffice' | awk '{print "  " $3}' | sort
