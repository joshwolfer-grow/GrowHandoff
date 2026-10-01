#!/usr/bin/env python3
"""Quick test: text everyone in a CSV from this Mac's Messages app.

Previews only unless you pass --send.

  python3 send_test.py test-list.csv "Hey {first}, test from Grow"
  python3 send_test.py list.csv "...{base} per deal..."   # any CSV column works
  python3 send_test.py test-list.csv "Hey {first}, test from Grow"
  python3 send_test.py list.csv "...{base} per deal..."   # any CSV column works --send
  python3 send_test.py test-list.csv "..." --send --sms     # force green bubble
"""
import argparse, csv, datetime, os, re, subprocess, sys, time

HERE = os.path.dirname(os.path.abspath(__file__))
SENDER = os.path.join(HERE, "send.applescript")
LOG = os.path.join(HERE, "sent-log.csv")


def normalize(phone):
    digits = re.sub(r"\D", "", phone or "")
    if len(digits) == 10:
        digits = "1" + digits
    if len(digits) != 11 or not digits.startswith("1"):
        return None
    return "+" + digits


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("csv")
    ap.add_argument("message", help="use {first} and {name} for the rep's name")
    ap.add_argument("--send", action="store_true", help="actually send (default is preview)")
    ap.add_argument("--sms", action="store_true", help="send as SMS instead of iMessage")
    ap.add_argument("--delay", type=float, default=12, help="seconds between texts")
    args = ap.parse_args()

    with open(args.csv, newline="") as f:
        rows = list(csv.DictReader(f))

    service = "SMS" if args.sms else "iMessage"
    plan = []
    for r in rows:
        name = (r.get("name") or "").strip()
        phone = normalize(r.get("phone"))
        if not phone:
            print(f"SKIP  {name or '(no name)'}: bad phone {r.get('phone')!r}")
            continue
        first = name.split()[0] if name else "there"
        # Any column in the CSV can be a {placeholder} in the message, so a
        # blast with per-person numbers (comp, deals to next tier) needs no
        # second script. {first}/{name} stay available even if absent as columns.
        fields = dict(r, first=first, name=name)
        try:
            text = args.message.format(**fields)
        except KeyError as e:
            sys.exit(f"Message uses {e} but the CSV has no such column. "
                     f"Columns: {', '.join(rows[0].keys())}")
        plan.append((name, phone, text))

    print(f"\n{len(plan)} texts via {service}, {args.delay:g}s apart\n")
    for name, phone, text in plan:
        print(f"  {phone}  {name}\n    {text}")
    if not args.send:
        print("\nPreview only. Add --send to send.")
        return

    new_log = not os.path.exists(LOG)
    with open(LOG, "a", newline="") as lf:
        log = csv.writer(lf)
        if new_log:
            log.writerow(["time", "name", "phone", "service", "result", "message"])
        for i, (name, phone, text) in enumerate(plan):
            res = subprocess.run(["osascript", SENDER, phone, text, service],
                                 capture_output=True, text=True)
            ok = res.returncode == 0
            result = "sent" if ok else "error: " + res.stderr.strip()
            print(f"{'OK ' if ok else 'ERR'}  {phone}  {name}  {'' if ok else result}")
            log.writerow([datetime.datetime.now().isoformat(timespec="seconds"),
                          name, phone, service, result, text])
            lf.flush()
            if i < len(plan) - 1:
                time.sleep(args.delay)
    print(f"\nDone. Log: {LOG}")


if __name__ == "__main__":
    sys.exit(main())
