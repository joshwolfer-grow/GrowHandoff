#!/usr/bin/env python3
"""Email a crawler failure (expired token, failed run) instead of a Mac banner.

  python3 scripts/alert-email.py <name> <ok|fail> [detail] [fix] [cadence] [--dry]

Called by sync-marker.sh on every marker write, so every runner that reports to
the health board gets this for free. Banners vanished the moment they were
dismissed and never reached a phone; an email sits in the inbox until handled.

ONE email per outage, nothing else (changed 2026-10-19: the recovered mails and
12h reminders doubled the volume and most Ezee failures cleared themselves on
the next tick anyway):
  ok -> fail          one "FAILED" email with the fix command
  still failing       silence, the health board shows it
  fail -> ok          silence, state resets so the next outage mails again
Sources that run on the knock schedule (every 10-30 min) must fail TWICE in a
row before the email goes out, so a single slow render never pages anyone.
Daily sources mail on the first failure.
State lives in imports/done/alerts/<name>.

Sends from and to GMAIL_USER via Gmail SMTP with GMAIL_APP_PASSWORD (.env.prod,
same credentials mail-leads-pull.py reads). ALERT_EMAIL_TO overrides the recipient.
Never fails the caller: a broken alert must not break a sync.
"""
import os
import smtplib
import sys
import time
from email.message import EmailMessage

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATE_DIR = os.path.join(ROOT, 'imports', 'done', 'alerts')
LOG = os.path.join(STATE_DIR, 'alerts.log')
# Consecutive failures required before mailing, by cadence label (arg 5).
FAST_STRIKES = 2
# rtr_sync is the roll-up of the per-ISP rtr_sync_<src> markers, which already mail.
SKIP = {'rtr_sync', 'rtr_seal'}
LABELS = {
    'sr_health': 'SalesRabbit sync',
    'amplify_sync': 'Amplify sync',
    'isp_export': 'ISP workbooks',
    'sector_maps': 'ISP maps',
}


def env():
    out = {}
    try:
        with open(os.path.join(ROOT, '.env.prod')) as f:
            for line in f:
                if '=' in line and not line.lstrip().startswith('#'):
                    k, v = line.split('=', 1)
                    out[k.strip()] = v.strip().strip('"').strip("'")
    except OSError:
        pass
    return out


def label(name):
    if name.startswith('rtr_sync_'):
        return 'Opendoor sync (' + name[len('rtr_sync_'):] + ')'
    return LABELS.get(name, name.replace('_', ' '))


def log(msg):
    with open(LOG, 'a') as f:
        f.write(time.strftime('%Y-%m-%d %H:%M:%S') + ' ' + msg + '\n')


def send(subject, body, dry):
    e = env()
    user, pw = e.get('GMAIL_USER'), e.get('GMAIL_APP_PASSWORD')
    to = e.get('ALERT_EMAIL_TO') or user
    if dry:
        print(f'To: {to}\nSubject: {subject}\n\n{body}')
        return True
    if not user or not pw:
        log('no GMAIL_USER / GMAIL_APP_PASSWORD in .env.prod, not sent: ' + subject)
        return False
    m = EmailMessage()
    m['From'], m['To'], m['Subject'] = user, to, subject
    m.set_content(body)
    with smtplib.SMTP_SSL('smtp.gmail.com', 465, timeout=20) as s:
        s.login(user, pw)
        s.send_message(m)
    log('sent: ' + subject)
    return True


def main():
    args = [a for a in sys.argv[1:] if a != '--dry']
    dry = '--dry' in sys.argv
    if len(args) < 2:
        return
    name, status = args[0], args[1]
    detail = args[2] if len(args) > 2 else ''
    fix = args[3] if len(args) > 3 else ''
    cadence = args[4] if len(args) > 4 else ''
    if name in SKIP:
        return
    os.makedirs(STATE_DIR, exist_ok=True)
    path = os.path.join(STATE_DIR, name)
    # state: "<ok|fail> <consecutive fails> <1 if this outage already mailed>"
    try:
        parts = open(path).read().split()
        prev = parts[0]
        strikes = int(float(parts[1])) if prev == 'fail' and len(parts) > 1 and float(parts[1]) < 1e6 else 0
        mailed = parts[2] == '1' if len(parts) > 2 else (prev == 'fail')
    except (OSError, ValueError, IndexError):
        prev, strikes, mailed = 'ok', 0, False
    what = label(name)
    when = time.strftime('%a %b %-d, %-I:%M %p')

    if status == 'ok':
        if prev == 'fail' and not dry:
            log(f'recovered (no mail): {what}')
        if not dry:
            open(path, 'w').write('ok 0 0')
        return

    strikes += 1
    need = FAST_STRIKES if 'min' in cadence or 'knock' in cadence else 1
    if mailed or strikes < need:
        if not dry:
            open(path, 'w').write(f'fail {strikes} {int(mailed)}')
        return
    subject = f'Grow: {what} failed'
    body = f'{detail or "Run failed."}\n\n'
    if fix:
        body += f'To fix, run in ~/Grow/GrowSales:\n\n    {fix}\n\n'
    body += f'{when}. This is the only email for this outage; the health board shows when it clears.\n'
    sent = send(subject, body, dry)
    if not dry:
        open(path, 'w').write(f'fail {strikes} {int(bool(sent))}')


if __name__ == '__main__':
    try:
        main()
    except Exception as ex:  # never break the sync over an alert
        try:
            log(f'error: {ex}')
        except Exception:
            pass
