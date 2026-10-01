#!/usr/bin/env python3
"""List the Messages group chats on this Mac, and send into one by name.

Reading the chat list needs Full Disk Access for whatever runs this.

  python3 groups.py --list
  python3 groups.py --list --match "daily report"
  python3 groups.py --send "Daily Report: Omni" "Yesterday: 1,240 doors, 14 sold"
  python3 groups.py --send "Daily Report: Omni" "..." --image ~/Pictures/omni.png
"""
import argparse, os, shutil, sqlite3, subprocess, sys

DB = os.path.expanduser("~/Library/Messages/chat.db")
HERE = os.path.dirname(os.path.abspath(__file__))
SENDER = os.path.join(HERE, "send-chat.applescript")
# Messages refuses files it can't reach from its own sandbox, and fails silently
# when it does. Copying into Pictures first is the reliable path.
STAGE = os.path.expanduser("~/Pictures/GrowReports")


def chats(match=None):
    q = """
    select c.guid, coalesce(nullif(c.display_name,''),'') as name,
           count(distinct h.id) as members,
           max(m.date) as last_date
    from chat c
    join chat_handle_join chj on chj.chat_id=c.ROWID
    join handle h on h.ROWID=chj.handle_id
    left join chat_message_join cmj on cmj.chat_id=c.ROWID
    left join message m on m.ROWID=cmj.message_id
    group by c.ROWID having members > 1
    order by last_date desc
    """
    con = sqlite3.connect("file:%s?mode=ro" % DB, uri=True)
    rows = [dict(guid=g, name=n, members=mem) for g, n, mem, _ in con.execute(q)]
    con.close()
    if match:
        m = match.lower()
        rows = [r for r in rows if m in (r["name"] or "").lower()]
    return rows


def find(name):
    hits = [c for c in chats() if (c["name"] or "").lower() == name.lower()]
    if not hits:
        hits = [c for c in chats(name)]
    if not hits:
        sys.exit("No group chat named %r. Run --list to see what exists." % name)
    if len(hits) > 1 and hits[0]["name"].lower() != name.lower():
        print("Multiple matches, using the most recent: " +
              ", ".join(h["name"] for h in hits[:4]))
    return hits[0]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--list", action="store_true")
    ap.add_argument("--match")
    ap.add_argument("--send", metavar="GROUP_NAME")
    ap.add_argument("message", nargs="?", default="")
    ap.add_argument("--image")
    a = ap.parse_args()

    if a.list or not a.send:
        for c in chats(a.match):
            print("%-38s %2d members  %s" % ((c["name"] or "(unnamed)")[:38], c["members"], c["guid"]))
        return

    chat = find(a.send)
    img = ""
    if a.image:
        src = os.path.expanduser(a.image)
        if not os.path.exists(src):
            sys.exit("No such image: " + src)
        os.makedirs(STAGE, exist_ok=True)
        img = os.path.join(STAGE, os.path.basename(src))
        if os.path.abspath(src) != img:
            shutil.copyfile(src, img)

    args = ["osascript", SENDER, chat["guid"], a.message] + ([img] if img else [])
    r = subprocess.run(args, capture_output=True, text=True)
    if r.returncode != 0:
        sys.exit("Send failed: " + r.stderr.strip())
    print("Sent to %s (%d members)%s" % (chat["name"], chat["members"], " with image" if img else ""))


if __name__ == "__main__":
    main()
