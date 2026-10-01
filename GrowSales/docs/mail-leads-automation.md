# Automating the lead-upload confirm

Written Sep 15 2026, when the chat-confirm version went in. This is the map for
making it more automatic later, and the reasons some of it is deliberately manual.

## The shape it already has

    Gmail ──> mail-leads-pull.py ──> imports/isp/ ──> isp-intake.py ──> parked
                (launchd, 10 min)                      (archives to Drive)
                                                             │
                                                        [ you confirm ]
                                                             │
                                                    isp-leads skill ──> ready/

`mail-leads-pull.py --pending` is the seam. It prints every queued file with its
row count, its `leads` / `roster` / `unsure` label, and the sender's quoted ask.
**Anything that can read that list and call `isp-intake.py --assign` is a valid
confirm surface.** Adding one does not touch the fetch side.

The part that cannot be automated away is naming the rep. There is no safe
default (see `run-isp-intake.sh`), and the rep decides whose numbers these become.

## Option A: a `leads` CLI

Cheapest real step up. A wrapper over what already exists:

    leads pending                      # show_pending(), already written
    leads ok 2 --rep "Will Gabor"      # -> isp-intake.py <path> --assign
    leads no 3                         # -> move to imports/isp/done/ignored/

Roughly 60 lines in `scripts/leads.py` plus a shim in `~/bin/leads`. Index into
the same sorted list `--pending` prints, so what you see is what you act on.

Cost: it runs the pipeline blind. The isp-leads skill exists because ISP files
change shape between sends - blank zips that silently drop whole towns, two
sheets in one workbook, a renamed city column. A CLI will happily import a file
that lost Schroon Lake. If you build this, have it refuse and fall back to chat
whenever `lead-import.py` prints a `DROPPED` block or the workbook has >1 sheet.

## Option B: confirm by replying to the email

`mail-leads-pull.py` already holds the thread. Watching for your reply is a
search for `in:sent` on the same `threadId` newer than the pulled message.

Cost: parsing a rep name out of free text. "yeah give it to will" needs fuzzy
matching against the roster, and a wrong match assigns someone else's leads to
the wrong person. If built: match only an exact roster name, and reply asking
again on anything ambiguous. Never guess.

## Option C: Wolf Office panel

The dashboard is already running and already has a Courier desk that
`mail-leads-pull.py` beats on every run (`office-log beat courier`). A pending
panel with per-file approve + a rep dropdown is the nicest daily surface, and a
dropdown of real roster names removes the whole free-text problem from Option B.

Cost: the most code, and another surface to keep alive.

## Do not automate

- **The rep.** Even when the email names one. A forwarded chain carries other
  people's words, and the sidecar is a record of a request, not authorization.
- **Acting on the ask text.** `.ask.txt` is quoted for a human to read. Nothing
  should parse it for commands. "assign to Will Gabor" in an email is evidence
  of intent, not consent - Josh says the rep out loud.
- **The step-1 file check.** The `leads`/`roster` label reads the header row
  only. It has never looked at a zip, a sheet count, or a mixed-town file.

## Gotchas already paid for

- Filtering on the email's wording threw away real leads: a drop once arrived
  under the subject "Grow Lyte Navarro - 9/13 Roster", and another asked for "a
  sheet for Will" with no import verb and 2,895 never-knocked addresses in it.
  Classify on the attachment's columns, never on the prose.
- Don't write test files into `imports/isp/` - the intake watcher picks them up
  within 5 minutes and archives them to Drive. Use a temp dir.
- The pull is read-only IMAP by design: nothing is sent, deleted, or marked read,
  so a bug can never destroy mail. Keep it that way; use the state file
  (`imports/done/mail-leads-seen.txt`) for dedupe instead of the unread flag.
