#!/usr/bin/env python3
"""Put every knocking pull on one calendar.

    python3 scripts/knock-schedule.py            # rewrite plists + reload agents
    python3 scripts/knock-schedule.py --print    # just list the run times

Knocking hours get a pull every 10 minutes, 11:00am through 10:00pm. Outside
them it is every 2 hours on the even hour: 12am, 2am, ..., 10am. So the day
reads 12am, 2am, 4am, 6am, 8am, 10am, 11am, 11:10am, ..., 9:50pm, 10pm.

Applies to the three agents that write the knocking table:
  com.grow.sr-sync       SalesRabbit crawl        (run-grow-sync.sh)
  com.grow.amplify-sync  TDS Amplify              (run-amplify-sync.sh)
  com.grow.rtr-sync      Opendoor ISPs            (run-rtr-sync.sh)

It swaps StartInterval for a StartCalendarInterval list in both the installed
plist (~/Library/LaunchAgents) and the checked-in template (scripts/launchd),
so install-agents.sh on a new Mac lands on the same schedule. launchd coalesces
calendar firings missed while the lid is shut into ONE run on wake, and each
sync's watermark means that one run covers the whole gap.

The health board reads the same calendar (the `slots` rows in index.html), so
if you change the hours here, change _growSyncState too.
"""
import os, re, subprocess, sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
LA = os.path.expanduser('~/Library/LaunchAgents')
AGENTS = ['com.grow.sr-sync', 'com.grow.amplify-sync', 'com.grow.rtr-sync']
DAY_START, DAY_END = 11, 22      # every 10 min from 11:00 up to and including 22:00


def slots():
    out = []
    for h in range(24):
        if DAY_START <= h < DAY_END:
            out += [(h, m) for m in range(0, 60, 10)]
        elif h == DAY_END or h % 2 == 0:
            out.append((h, 0))
    return out


def calendar_xml(indent):
    i1, i2 = indent, indent + ('\t' if '\t' in indent else '  ')
    rows = ''.join(f'{i2}<dict><key>Hour</key><integer>{h}</integer><key>Minute</key><integer>{m}</integer></dict>\n'
                   for h, m in slots())
    return f'{i1}<key>StartCalendarInterval</key>\n{i1}<array>\n{rows}{i1}</array>'


PAT = re.compile(r'([ \t]*)<key>(?:StartInterval</key>\s*<integer>\d+</integer>|'
                 r'StartCalendarInterval</key>\s*(?:<array>.*?</array>|<dict>.*?</dict>))', re.S)


def rewrite(path):
    if not os.path.exists(path):
        return False
    s = open(path).read()
    m = PAT.search(s)
    if not m:
        print(f'  !! no schedule key in {path}')
        return False
    s2 = s[:m.start()] + calendar_xml(m.group(1)) + s[m.end():]
    if s2 != s:
        open(path, 'w').write(s2)
    return True


def main():
    if '--print' in sys.argv:
        fmt = lambda h, m: f"{h % 12 or 12}{'' if m == 0 else f':{m:02d}'}{'am' if h < 12 else 'pm'}"
        print(f'{len(slots())} runs/day: ' + ', '.join(fmt(h, m) for h, m in slots()))
        return
    for a in AGENTS:
        rewrite(os.path.join(ROOT, 'scripts/launchd', a + '.plist'))
        live = os.path.join(LA, a + '.plist')
        if rewrite(live):
            subprocess.run(['plutil', '-lint', '-s', live], check=True)
            subprocess.run(['launchctl', 'unload', live], stderr=subprocess.DEVNULL)
            subprocess.run(['launchctl', 'load', live], check=True)
            print(f'  {a}: {len(slots())} runs/day, reloaded')


if __name__ == '__main__':
    main()
