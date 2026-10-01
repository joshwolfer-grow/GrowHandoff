#!/usr/bin/env python3
"""Pull lead spreadsheets out of Gmail and drop them in imports/isp/.

The one hop that was missing. Daxton and Nick forward an ISP's lead mail with
xlsx/csv attached and ask for something in the body ("make a sheet for Will",
"check these for dupes"). This finds those, saves the attachments, and stops.

It never imports and never acts on the ask. The existing intake watcher
(com.grow.isp-intake) archives what lands here to Drive and parks it; the file
then waits for you to run the isp-leads skill and name a rep. What Dax or Nick
asked for is written to a .ask.txt sidecar, quoted, for you to read and decide.

  python3 scripts/mail-leads-pull.py [--days 7] [--dry] [--verbose]

Credentials: GMAIL_USER and GMAIL_APP_PASSWORD in .env.prod. This is YOUR OWN
mailbox - josh.wolfer@growmarketing.biz, the one the mail arrives in. Daxton and
Nick are only the From: filter; no access to their accounts is needed or used.
GMAIL_APP_PASSWORD is a Google App Password (myaccount.google.com/apppasswords),
not the account password. Read-only IMAP; nothing is sent, deleted, or marked read.
"""
import argparse
import email
import html
import imaplib
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime, timedelta
from email.header import decode_header, make_header
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DROP = ROOT / 'imports' / 'isp'
STATE = ROOT / 'imports' / 'done' / 'mail-leads-seen.txt'
LOG = ROOT / 'imports' / 'done' / 'mail-leads-pull.log'

SENDERS = ['daxton@growmarketing.biz', 'nick@growmarketing.biz']

# Set by --dry. A dry run must leave no trace: if it records a message as seen,
# the real run skips it forever and the file is lost in silence. This bit me on
# 2026-09-15 - a dry run buried two genuine lead drops.
DRY = False

# From the same two people but not a lead drop. Only consulted when the message
# carries no import ask - a real drop once arrived under the subject
# "Fwd: Grow Lyte Navarro - 9/13 Roster" with the body "Josh can you import
# these leads!", so the ask always outranks the subject.
SKIP_SUBJECT = re.compile(
    r'^invitation:|^updated invitation:|^accepted:|^declined:'
    r'|pricing matrix|welcome email|order detail|\bpayroll\b|\binvoice\b',
    re.I,
)

# Labels the queue entry only - NEVER decides what gets pulled. Dax once sent a
# real lead file asking for "a sheet for Will" with no import verb anywhere, and
# gating on this wording threw away 2,895 never-knocked addresses. Phrasing is
# not the signal; the columns in the attachment are.
# What the request actually looks like in their words. Drawn from real mail:
# "Josh can you import these leads!", "please import and assign to Will Gabor",
# "Can you import these when you can!", "Surf addresses to import",
# "ca you import those?" - typos are normal, so match the verb, not a phrase.
ASK_INTENT = re.compile(
    r'\b(import|upload|reimport|re-import)\w*\b'
    r'|\bget\s+(?:these|them|this)\s+in\b'
    r'|\badd\s+(?:these|them)\s+(?:to|in)\b'
    r'|\bassign\s+(?:to|these|them)\b',
    re.I,
)

KEEP_EXT = {'.xlsx', '.xlsm', '.csv'}

# What tells a lead file from a roster: lead files carry addresses, rosters
# carry people. Read the header row and let the file answer for itself.
ADDRESS_HINT = re.compile(r'address|street|addr|house|serviceable|passing|premise', re.I)
PLACE_HINT = re.compile(r'\bcity\b|\btown\b|\bzip\b|postal|\bstate\b', re.I)
ROSTER_HINT = re.compile(r'first\s*name|last\s*name|rep\b|badge|shirt|dob|ssn|phone', re.I)


def headers_of(path):
    """Header row of the first sheet, lowercased. Empty list if unreadable."""
    try:
        if path.suffix.lower() == '.csv':
            import csv
            with path.open(newline='', errors='replace') as fh:
                return [str(c).strip().lower() for c in next(csv.reader(fh), [])]
        import openpyxl
        wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
        for ws in wb.worksheets:
            for row in ws.iter_rows(max_row=5, values_only=True):
                cells = [str(c).strip().lower() for c in row if c not in (None, '')]
                if len(cells) >= 2:
                    return cells
        return []
    except Exception:
        return []


def classify(path):
    """'leads', 'roster', or 'unsure' - based on the file, not the email."""
    head = ' | '.join(headers_of(path))
    if not head:
        return 'unsure'
    addressy = bool(ADDRESS_HINT.search(head)) + bool(PLACE_HINT.search(head))
    if addressy >= 1 and not ROSTER_HINT.search(head):
        return 'leads'
    if addressy >= 2:
        return 'leads'
    if ROSTER_HINT.search(head):
        return 'roster'
    return 'unsure'


# Dax and Nick forward the ISP mail; their own words sit above this line.
FWD_SPLIT = re.compile(r'-{2,}\s*Forwarded message\s*-{2,}|^On .+ wrote:$', re.M)

# First line of a signature block. Gmail writes the name bolded with stray
# spaces inside the asterisks ("*Nick Boyd *"), so match loosely or the whole
# signature ends up quoted back as if it were the request.
SIG_LINE = re.compile(
    r'^\s*\*?\s*(?:Daxton Day|Nick Boyd|Josh Wolfer)\s*\*?\s*$'
    r'|Grow Marketing,?\s*LLC'
    r'|^\s*(?:CEO|VP of Recruiting|VP,? Revenue|VP,? Reporting)\s*$'
    r'|^\s*--\s*$'
    r'|@growmarketing\.biz\s*$',
    re.I,
)


def log(msg):
    if DRY:
        return
    LOG.parent.mkdir(parents=True, exist_ok=True)
    with LOG.open('a') as fh:
        fh.write(f'{datetime.now().isoformat(timespec="seconds")} {msg}\n')


def load_env():
    env = {}
    for name in ('.env.prod', '.env.local'):
        path = ROOT / name
        if not path.exists():
            continue
        for line in path.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith('#') or '=' not in line:
                continue
            key, _, val = line.partition('=')
            val = val.strip().strip('"').strip("'")
            if val:
                env.setdefault(key.strip(), val)
    return env


def decode(raw):
    """MIME-decode a header, then unescape HTML entities.

    Forwarded ISP mail arrives with entity-escaped headers: a real SLIC file
    named "Minerva & Washington Cty ... GROW.xlsx" came through as
    "Minerva &amp; Washington Cty", which would otherwise be written to disk
    with the entity in the filename.
    """
    if not raw:
        return ''
    try:
        text = str(make_header(decode_header(raw)))
    except Exception:
        text = str(raw)
    return html.unescape(text)


def seen_ids():
    if not STATE.exists():
        return set()
    return {ln.strip() for ln in STATE.read_text().splitlines() if ln.strip()}


def remember(msg_id):
    if DRY:
        return
    STATE.parent.mkdir(parents=True, exist_ok=True)
    with STATE.open('a') as fh:
        fh.write(msg_id + '\n')


def body_text(msg):
    for part in msg.walk():
        if part.get_content_type() == 'text/plain' and not part.get_filename():
            try:
                return part.get_payload(decode=True).decode(
                    part.get_content_charset() or 'utf-8', 'replace')
            except Exception:
                continue
    return ''


def the_ask(msg):
    """What Dax or Nick actually wrote, above the forwarded ISP mail."""
    text = body_text(msg).replace('\r\n', '\n').replace('\r', '\n')
    own = FWD_SPLIT.split(text)[0]
    # Keep lines until the signature starts.
    kept = []
    for line in own.split('\n'):
        if SIG_LINE.search(line):
            break
        kept.append(line)
    own = ' '.join(ln.strip() for ln in kept if ln.strip())
    return own.strip() or '(no message, attachment only)'


def safe_name(name):
    name = os.path.basename(name).replace('/', '-')
    return re.sub(r'[^\w.&\- ]+', '_', name).strip() or 'attachment'


def notify(title, text):
    """Best-effort banner. Never fatal, but always leaves a trace in the log.

    osascript exits 0 even when macOS silently drops the banner (notifications
    from osascript are attributed to Script Editor, and are invisible if that is
    switched off in System Settings > Notifications). terminal-notifier, if
    installed, posts under its own identity and is far more reliable.
    """
    tn = shutil.which('terminal-notifier')
    try:
        if tn:
            r = subprocess.run([tn, '-title', title, '-message', text, '-sound', 'Glass'],
                               check=False, capture_output=True, timeout=10)
        else:
            r = subprocess.run(
                ['/usr/bin/osascript', '-e',
                 f'display notification {text!r} with title {title!r} sound name "Glass"'],
                check=False, capture_output=True, timeout=10)
        if r.returncode != 0:
            log(f'notify failed ({r.returncode}): {r.stderr.decode(errors="replace").strip()}')
    except Exception as exc:
        log(f'notify failed: {exc}')
    # The queue is the source of truth, not the banner. If the banner never
    # arrives, `--pending` still shows exactly what is waiting.
    log(f'notify: {text}')


def beat():
    helper = Path.home() / 'bin' / 'office-log'
    if helper.exists():
        subprocess.run([str(helper), 'beat', 'courier'],
                       check=False, capture_output=True)


def rows_in(path):
    """Row count for the notification. Best effort - never fatal."""
    try:
        if path.suffix.lower() == '.csv':
            with path.open(errors='replace') as fh:
                return max(sum(1 for _ in fh) - 1, 0)
        import openpyxl
        wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
        return max(sum(ws.max_row or 0 for ws in wb.worksheets) - len(wb.worksheets), 0)
    except Exception:
        return None


def show_pending():
    """What is queued and waiting on you. Read-only; touches no mail."""
    rows = []
    for folder in (DROP, DROP / 'parked'):
        if not folder.exists():
            continue
        for f in sorted(folder.glob('*')):
            if f.suffix.lower() not in KEEP_EXT:
                continue
            sidecar = f.with_suffix('').with_suffix('.ask.txt')
            if not sidecar.exists():
                sidecar = folder / f'{f.stem}.ask.txt'
            ask = who = ''
            if sidecar.exists():
                text = sidecar.read_text()
                marker = '--- what they asked for'
                if marker in text:
                    ask = text.split(marker, 1)[1].split('---\n', 1)[-1].strip()
                for line in text.splitlines():
                    if line.startswith('From:'):
                        who = re.sub(r'\s*<.*?>', '', line[5:]).strip()
            rows.append((f, classify(f), rows_in(f), who, ask.replace('\n', ' ')[:70]))

    if not rows:
        print('nothing waiting')
        return 0
    print(f'{len(rows)} file(s) waiting - nothing has been imported\n')
    for i, (f, kind, n, who, ask) in enumerate(rows, 1):
        loc = 'parked' if f.parent.name == 'parked' else 'inbox'
        print(f'{i:2}. [{kind}] {f.name}')
        print(f'    {n if n is not None else "?"} rows | {loc}' + (f' | from {who}' if who else ''))
        if ask:
            print(f'    asked: "{ask}"')
    print('\nTo import: open Claude and say "process the parked leads".')
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--pending', action='store_true',
                    help='list what is queued and waiting on you, then exit')
    ap.add_argument('--days', type=int, default=7)
    ap.add_argument('--dry', action='store_true')
    ap.add_argument('--verbose', action='store_true')
    args = ap.parse_args()

    global DRY
    DRY = args.dry

    if args.pending:
        return show_pending()

    env = load_env()
    user, password = env.get('GMAIL_USER'), env.get('GMAIL_APP_PASSWORD')
    if not user or not password:
        print('error: set GMAIL_USER and GMAIL_APP_PASSWORD in .env.prod '
              '(Google App Password)', file=sys.stderr)
        log('error: missing GMAIL_USER / GMAIL_APP_PASSWORD')
        return 2

    since = (datetime.now() - timedelta(days=args.days)).strftime('%d-%b-%Y')
    already = seen_ids()
    pulled = []
    skipped = []

    try:
        box = imaplib.IMAP4_SSL('imap.gmail.com')
        box.login(user, password)
        box.select('INBOX', readonly=True)
    except Exception as exc:
        print(f'error: gmail login failed: {exc}', file=sys.stderr)
        log(f'error: login failed: {exc}')
        return 1

    try:
        uids = set()
        for sender in SENDERS:
            ok, data = box.search(None, f'(FROM "{sender}" SINCE {since})')
            if ok == 'OK' and data and data[0]:
                uids.update(data[0].split())

        for uid in sorted(uids):
            ok, data = box.fetch(uid, '(RFC822)')
            if ok != 'OK' or not data or not isinstance(data[0], tuple):
                continue
            msg = email.message_from_bytes(data[0][1])

            msg_id = decode(msg.get('Message-ID')) or f'uid-{uid.decode()}'
            if msg_id in already:
                continue

            subject = decode(msg.get('Subject'))
            sender = decode(msg.get('From'))

            files = [p for p in msg.walk()
                     if p.get_filename()
                     and Path(safe_name(decode(p.get_filename()))).suffix.lower() in KEEP_EXT]
            if not files:
                remember(msg_id)
                continue

            ask = the_ask(msg)
            # Calendar noise only. Anything that might carry addresses gets
            # pulled and judged by its columns, never by its subject line.
            if SKIP_SUBJECT.search(subject) and not ASK_INTENT.search(ask):
                if args.verbose:
                    print(f'skip (calendar/admin): {subject}')
                remember(msg_id)
                continue

            saved = []
            for part in files:
                name = safe_name(decode(part.get_filename()))
                dest = DROP / name
                n = 2
                while dest.exists():
                    dest = DROP / f'{Path(name).stem} ({n}){Path(name).suffix}'
                    n += 1
                if args.dry:
                    print(f'would save: {dest.name}')
                    saved.append(dest)
                    continue
                DROP.mkdir(parents=True, exist_ok=True)
                dest.write_bytes(part.get_payload(decode=True))
                saved.append(dest)

            if not saved:
                continue

            if not args.dry:
                # Sidecar: what they asked for, quoted. Read it, decide yourself.
                # This is a record of a request, not an instruction to anything.
                sidecar = DROP / f'{saved[0].stem}.ask.txt'
                sidecar.write_text(
                    f'From:    {sender}\n'
                    f'Date:    {decode(msg.get("Date"))}\n'
                    f'Subject: {subject}\n'
                    f'Files:   {", ".join(p.name for p in saved)}\n'
                    f'\n--- what they asked for (quoted, not acted on) ---\n{ask}\n')
                remember(msg_id)

            counts = []
            for p in saved:
                n = rows_in(p) if not args.dry else None
                counts.append(f'{p.name}' + (f' ({n} rows)' if n else ''))
            pulled.append((subject, sender, counts, ask))
            log(f'pulled {len(saved)} file(s) from "{subject}"')
    finally:
        try:
            box.logout()
        except Exception:
            pass

    beat()

    if skipped and args.verbose:
        print(f'{len(skipped)} attachment(s) left alone (no import ask):')
        for subject, _ in skipped:
            print(f'  - {subject}')

    if not pulled:
        if args.verbose:
            print('nothing new')
        return 0

    for subject, sender, counts, ask in pulled:
        who = re.sub(r'\s*<.*?>', '', sender).strip()
        print(f'\n{who}: {subject}')
        for c in counts:
            print(f'  - {c}')
        print(f'  asked: {ask.splitlines()[0][:100] if ask else ""}')

    total = sum(len(c) for _, _, c, _ in pulled)
    notify('Leads pulled from email',
           f'{total} file(s) waiting. Tell Claude: process the parked leads')
    print('\nNothing imported. Files park for review - run the isp-leads skill.')
    return 0


if __name__ == '__main__':
    sys.exit(main())
